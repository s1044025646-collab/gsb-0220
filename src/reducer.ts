/**
 * 核心还原器：按 Unicode 码点顺序处理同一行的覆盖行为。
 * - 普通字符写入当前光标位置（覆盖该位置已有字符）
 * - \r 回到当前行行首（不删除字符）
 * - \n 提交当前行，进入下一行行首
 * - \b 光标左移一格，不删除字符
 * - 支持 CSI ... m（SGR，忽略）与 CSI [0/1/2] K（行擦除）
 * - 其余 CSI / ESC 序列与文件末尾未结束的序列产生诊断
 * 位置按 Unicode 码点计，不模拟宽字符/组合字符列宽。
 */

export interface Diagnostic {
  code: string;
  message: string;
  /** 输入流中的码点偏移（近似，供定位） */
  offset: number;
}

export interface ReduceResult {
  text: string;
  diagnostics: Diagnostic[];
}

const MAX_ESC_LEN = 64;

export class Reducer {
  private lines: string[][] = [[]];
  private line = 0;
  private col = 0;
  private escBuf = "";
  private inEsc = false;
  private offset = 0;
  readonly diagnostics: Diagnostic[] = [];

  /** 输入一个已解码的字符串块（UTF-8 解码由调用方用 string_decoder 保证跨块安全） */
  feed(chunk: string): void {
    for (const ch of chunk) {
      const pos = this.offset++;
      if (this.inEsc) {
        this.escBuf += ch;
        if (this.escBuf.length > MAX_ESC_LEN) {
          this.diag("UNTERMINATED_ESCAPE", `转义序列过长（>${MAX_ESC_LEN} 码点），按未支持处理`, pos);
          this.inEsc = false;
          this.escBuf = "";
        } else if (this.isEscComplete()) {
          this.handleEscape(this.escBuf, pos);
          this.inEsc = false;
          this.escBuf = "";
        }
        continue;
      }
      if (ch === "\x1b") {
        this.inEsc = true;
        this.escBuf = ch;
      } else if (ch === "\r") {
        this.col = 0;
      } else if (ch === "\n") {
        this.line++;
        this.col = 0;
        if (this.lines.length <= this.line) this.lines.push([]);
      } else if (ch === "\b") {
        this.col = Math.max(0, this.col - 1);
      } else if (ch === "\t") {
        this.writeChar("\t");
      } else {
        const cp = ch.codePointAt(0)!;
        if (cp < 0x20 || cp === 0x7f) {
          this.diag("UNSUPPORTED_CONTROL", `未支持的控制字符 U+${cp.toString(16).toUpperCase().padStart(4, "0")}，已忽略`, pos);
        } else {
          this.writeChar(ch);
        }
      }
    }
  }

  /** 结束输入，检查末尾是否有未结束的转义序列，返回结果 */
  finalize(): ReduceResult {
    if (this.inEsc) {
      this.diag("UNTERMINATED_ESCAPE", `输入结束时存在未完成的转义序列: ${JSON.stringify(this.escBuf)}`, this.offset);
      this.inEsc = false;
      this.escBuf = "";
    }
    const text = this.lines.map((l) => l.join("")).join("\n");
    return { text, diagnostics: this.diagnostics };
  }

  private writeChar(ch: string): void {
    const line = this.lines[this.line];
    if (this.col < line.length) line[this.col] = ch;
    else line.push(ch);
    this.col++;
  }

  private eraseLine(mode: number): void {
    const line = this.lines[this.line];
    if (mode === 0) line.length = Math.min(line.length, this.col); // 光标到行尾
    else if (mode === 1) line.fill(" ", 0, Math.min(this.col, line.length)); // 行首到光标（以空格清除）
    else line.length = 0; // 整行
    if (mode === 2) line.length = 0;
  }

  private isEscComplete(): boolean {
    const b = this.escBuf;
    if (b.length < 2) return false;
    if (b[1] === "[") {
      if (b.length < 3) return false;
      const last = b.charCodeAt(b.length - 1);
      return last >= 0x40 && last <= 0x7e; // CSI 最终字节
    }
    return b.length >= 2; // 非 CSI 的 ESC 序列，按两字节视为完整（随后报未支持）
  }

  private handleEscape(seq: string, pos: number): void {
    const m = /^\x1b\[([0-9;]*)([A-Za-z])$/.exec(seq);
    if (m) {
      const [, params, final] = m;
      if (final === "m") return; // SGR 颜色，忽略
      if (final === "K") {
        const mode = params === "" ? 0 : parseInt(params, 10);
        if (mode === 0 || mode === 1 || mode === 2) {
          this.eraseLine(mode);
          return;
        }
      }
      this.diag("UNSUPPORTED_ESCAPE", `未支持的光标/控制序列 ${JSON.stringify(seq)}，已忽略`, pos);
      return;
    }
    this.diag("UNSUPPORTED_ESCAPE", `未支持的转义序列 ${JSON.stringify(seq)}，已忽略`, pos);
  }

  private diag(code: string, message: string, offset: number): void {
    this.diagnostics.push({ code, message, offset });
  }
}

/** 一次性便捷接口 */
export function reduceText(chunks: Iterable<string>): ReduceResult {
  const r = new Reducer();
  for (const c of chunks) r.feed(c);
  return r.finalize();
}
