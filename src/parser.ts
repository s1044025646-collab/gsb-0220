/**
 * 终端输出还原引擎。
 *
 * 处理模型（仅模拟普通命令行的逐行输出，不是完整终端模拟器）：
 * - 普通字符写入当前光标位置（按 Unicode 码点计位置）。
 * - CR（\r）回到当前行首，不提交行；随后写入的字符覆盖旧字符。
 * - LF（\n）提交当前行；CRLF 作为一次换行处理。
 * - BS（\b）只把光标向左移动一格，不自动删除字符。
 * - TAB 跳到下一个 8 列制表位（写入空白）。
 * - CSI SGR（颜色等，ESC[...m）被忽略。
 * - CSI K（擦除）：0=从光标擦到行尾，1=从行首擦到光标，2=整行擦除。
 *
 * 限制：按 Unicode 码点计位置，不模拟中日韩宽字符、组合字符或表情的真实终端列宽。
 * 输入按字节分块时由 decodeUtf8 保证跨块字符不被解坏；未结束的转义序列
 * 可以跨多个输入块在 Parser 内部继续累积。
 */

export type Severity = 'warning' | 'error';

export interface Diagnostic {
  code: string;
  severity: Severity;
  message: string;
  /** 诊断发生时已经处理的 Unicode 码点偏移 */
  offset: number;
  /** 触发问题的原始片段（可能为不完整序列） */
  raw?: string;
}

export interface ParseResult {
  text: string;
  diagnostics: Diagnostic[];
}

const ESC = 0x1b;
const CR = 0x0d;
const LF = 0x0a;
const BS = 0x08;
const TAB = 0x09;

/**
 * 按字节解码 UTF-8：可接受任意分块边界，跨块的多字节字符会被正确拼回。
 * 遇到非法 UTF-8 字节时抛出异常（由上层记为失败转换）。
 */
export class Utf8Decoder {
  private pending: number[] = [];

  write(chunk: Buffer): string {
  const bytes = [...this.pending, ...chunk];
  this.pending = [];
  let out = '';
  let i = 0;
  while (i < bytes.length) {
    const b0 = bytes[i];
    let extra: number;
    let min: number;
    let code: number;
    if (b0 <= 0x7f) {
      out += String.fromCharCode(b0);
      i += 1;
      continue;
    } else if ((b0 & 0xe0) === 0xc0) {
      extra = 1;
      min = 0x80;
      code = b0 & 0x1f;
    } else if ((b0 & 0xf0) === 0xe0) {
      extra = 2;
      min = 0x800;
      code = b0 & 0x0f;
    } else if ((b0 & 0xf8) === 0xf0) {
      extra = 3;
      min = 0x10000;
      code = b0 & 0x07;
    } else {
      throw new Utf8Error(i, `非法 UTF-8 起始字节: 0x${b0.toString(16)}`);
    }
    if (i + extra >= bytes.length) {
      // 序列可能在后续块中续上；末尾多出的字节一律保留。
      this.pending = bytes.slice(i);
      return out;
    }
    for (let k = 1; k <= extra; k++) {
      const b = bytes[i + k];
      if ((b & 0xc0) !== 0x80) {
        throw new Utf8Error(i + k, `非法 UTF-8 后续字节: 0x${b.toString(16)}`);
      }
      code = (code << 6) | (b & 0x3f);
    }
    if (code < min || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) {
      throw new Utf8Error(i, '非法 UTF-8 码点（越界或代理项）');
    }
    out += code > 0xffff
      ? String.fromCharCode(0xd800 + ((code - 0x10000) >> 10), 0xdc00 + ((code - 0x10000) & 0x3ff))
      : String.fromCharCode(code);
    i += 1 + extra;
  }
  return out;
}

  finish(): string {
    if (this.pending.length > 0) {
      const at = this.pending[0];
      this.pending = [];
      throw new Utf8Error(0, `文件结束时存在不完整的 UTF-8 序列（起始字节 0x${at.toString(16)}）`);
    }
    return '';
  }
}

export class Utf8Error extends Error {
  readonly byteOffset: number;
  constructor(byteOffset: number, message: string) {
    super(message);
    this.name = 'Utf8Error';
    this.byteOffset = byteOffset;
  }
}

/**
 * 增量式终端行还原器。可多次 write，最后 finish 取结果。
 */
export class Parser {
  private lines: string[] = [];
  private current: string[] = [];
  private col = 0;
  /** 已消费的码点总数（诊断定位用） */
  private offset = 0;
  /** 未结束的控制序列缓冲，如 '\x1b[' 或 '\x1b[31'，可跨输入块 */
  private seq: string[] | null = null;
  private diagnostics: Diagnostic[] = [];

  write(text: string): void {
    for (const ch of text) {
      this.offset += 1;
      if (this.seq) {
        this.consumeSeq(ch);
      } else {
        this.consume(ch);
      }
    }
  }

  private consume(ch: string): void {
    const cp = ch.codePointAt(0)!;
    if (cp === ESC) {
      this.seq = [ch];
      return;
    }
    if (cp === CR) {
      // CR 只回到行首；CRLF 中的 LF 会在下面正常提交当前行，恰好一次。
      this.col = 0;
      return;
    }
    if (cp === LF) {
      this.commitLine();
      return;
    }
    if (cp === BS) {
      if (this.col > 0) this.col -= 1;
      return;
    }
    if (cp === TAB) {
      const next = (Math.floor(this.col / 8) + 1) * 8;
      while (this.col < next) this.putChar(' ');
      return;
    }
    if (cp < 0x20 || cp === 0x7f) {
      this.warn('UNSUPPORTED_CONTROL', `不支持的控制字符 U+${cp.toString(16).padStart(4, '0')}，已忽略`, ch);
      return;
    }
    this.putChar(ch);
  }

  private putChar(ch: string): void {
    while (this.current.length <= this.col) this.current.push(' ');
    this.current[this.col] = ch;
    this.col += 1;
  }

  private commitLine(): void {
    const line = this.current.join('').replace(/[\u0020]+$/g, '');
    this.lines.push(line);
    this.current = [];
    this.col = 0;
  }

  /** 累积 ESC 转义序列，直到得到终字节并判定如何处理。 */
  private consumeSeq(ch: string): void {
    const seq = this.seq!;
    seq.push(ch);
    const raw = seq.join('');

    if (seq.length === 2) {
      if (ch === '[') return; // CSI 参数部分
      if (ch === ']') return; // OSC，继续在本缓冲里累积到 BEL/ST
      // ESC + 其它单字节指令（如 ESC M 反向换行）不在支持范围
      this.warn('UNSUPPORTED_ESCAPE', `不支持的转义序列: ${describe(raw)}`, raw);
      this.seq = null;
      return;
    }

    const isOSC = seq[1] === ']';
    if (isOSC) {
      // OSC 以 BEL 结束，或以 ST（ESC \）结束。
      if (ch === '\u0007') {
        this.warn('UNSUPPORTED_ESCAPE', `不支持的 OSC 序列，已忽略: ${describe(raw)}`, raw);
        this.seq = null;
        return;
      }
      if (ch === '\\') {
        this.warn('UNSUPPORTED_ESCAPE', `不支持的 OSC 序列，已忽略: ${describe(raw)}`, raw);
        this.seq = null;
        return;
      }
      if (raw.length > 1024) {
        this.warn('UNSUPPORTED_ESCAPE', 'OSC 序列过长且未正常结束，已放弃', raw);
        this.seq = null;
      }
      return;
    }

    // CSI：参数字节为 0x30–0x3f，中间字节 0x20–0x2f，终字节 0x40–0x7e。
    const cp = ch.codePointAt(0)!;
    const isFinal = cp >= 0x40 && cp <= 0x7e;
    if (!isFinal) {
      if (raw.length > 128 || cp < 0x20) {
        this.warn('UNSUPPORTED_ESCAPE', `畸形或过长的 CSI 序列，已放弃: ${describe(raw)}`, raw);
        this.seq = null;
      }
      return;
    }

    this.handleCSI(raw, ch);
    this.seq = null;
  }

  private handleCSI(raw: string, finalByte: string): void {
    const body = raw.slice(2, -1);
    if (finalByte === 'm') {
      // SGR：颜色/样式，全部忽略；空参数等价于重置，同样忽略。
      if (!/^[0-9;:]*$/.test(body)) {
        this.warn('UNKNOWN_SGR', `无法识别的 SGR 参数，已按样式指令忽略: ${describe(raw)}`, raw);
      }
      return;
    }
    if (finalByte === 'K') {
      const mode = body === '' || body === '0' ? 0 : body === '1' ? 1 : body === '2' ? 2 : -1;
      if (mode === -1) {
        this.warn('UNKNOWN_ERASE_MODE', `无法识别的 CSI K 参数: ${describe(raw)}`, raw);
        return;
      }
      this.eraseLine(mode);
      return;
    }
    this.warn(
      'UNSUPPORTED_CSI',
      `不支持的 CSI 指令（光标移动等不在支持范围）: ${describe(raw)}`,
      raw,
    );
  }

  private eraseLine(mode: 0 | 1 | 2): void {
    const len = this.current.length;
    const from = mode === 0 ? this.col : 0;
    const to = mode === 1 ? Math.min(this.col + 1, len) : len;
    for (let i = from; i < to; i++) this.current[i] = ' ';
  }

  finish(): ParseResult {
    if (this.seq) {
      const raw = this.seq.join('');
      this.warn('INCOMPLETE_ESCAPE', `文件结束时存在未结束的转义序列: ${describe(raw)}`, raw);
      this.seq = null;
    }
    // 以换行结尾时，最后一个 LF 已提交一行内容；尾部不再产生多余空行。
    if (this.current.length > 0) this.commitLine();
    return { text: this.lines.join('\n'), diagnostics: this.diagnostics };
  }

  private warn(code: string, message: string, raw?: string): void {
    const d: Diagnostic = { code, severity: 'warning', message, offset: this.offset };
    if (raw !== undefined) d.raw = raw;
    this.diagnostics.push(d);
  }
}

function describe(raw: string): string {
  return raw
    .replace(/\x1b/g, '\\x1b')
    .replace(/[\x00-\x1f]/g, (c) => `\\x${c.charCodeAt(0).toString(16).padStart(2, '0')}`);
}

/** 一次性还原字符串的便捷函数。 */
export function restore(input: string): ParseResult {
  const parser = new Parser();
  parser.write(input);
  return parser.finish();
}

/**
 * 按给定字节块大小还原 Buffer 流。不同块大小必须得到相同结果。
 */
export function restoreBufferChunks(chunks: Buffer[]): ParseResult {
  const decoder = new Utf8Decoder();
  const parser = new Parser();
  try {
    for (const chunk of chunks) parser.write(decoder.write(chunk));
    parser.write(decoder.finish());
  } catch (err) {
    if (err instanceof Utf8Error) {
      return {
        text: '',
        diagnostics: [{ code: 'INVALID_UTF8', severity: 'error', message: err.message, offset: err.byteOffset }],
      };
    }
    throw err;
  }
  return parser.finish();
}
