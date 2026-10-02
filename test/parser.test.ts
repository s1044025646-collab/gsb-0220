import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { Parser, restore, restoreBufferChunks, Utf8Decoder } from '../dist/src/parser.js';

function restoreStringByBytes(s: string, chunkSize: number) {
  const buf = Buffer.from(s, 'utf8');
  const chunks: Buffer[] = [];
  for (let i = 0; i < buf.length; i += chunkSize) chunks.push(buf.subarray(i, i + chunkSize));
  return restoreBufferChunks(chunks);
}

describe('基本行还原', () => {
  it('普通逐行输出', () => {
    assert.equal(restore('a\nb\nc').text, 'a\nb\nc');
  });

  it('CRLF 作为一次换行', () => {
    assert.equal(restore('line1\r\nline2\r\n').text, 'line1\nline2');
  });

  it('孤立 CR 不产生新行，LF 正常换行', () => {
    assert.equal(restore('a\rb\r\nc\n').text, 'b\nc');
  });
});

describe('回车覆盖（进度条场景）', () => {
  it('百分比进度更新最终还原为完成行', () => {
    const raw = '进度 0%\r进度 25%\r进度 75%\r进度 100% 完成\n';
    assert.equal(restore(raw).text, '进度 100% 完成');
  });

  it('短文本覆盖长文本残留旧字符', () => {
    // 没有擦除："done" 覆盖 "working" 前 4 个字符，残留 "ing"
    const r = restore('working\rdone\n');
    assert.equal(r.text, 'doneing');
  });

  it('CSI K 行尾擦除后短文本不残留', () => {
    const r = restore('working\r\x1b[Kdone\n');
    assert.equal(r.text, 'done');
    assert.equal(r.diagnostics.length, 0);
  });
});

describe('退格', () => {
  it('退格只移动光标，随后写入覆盖字符', () => {
    // "abx" 退一格写 c => "abc"
    assert.equal(restore('abx\bc\n').text, 'abc');
  });

  it('退格后不写入则原字符保留', () => {
    assert.equal(restore('abc\b\b\n').text, 'abc');
  });
});

describe('三种行擦除 CSI K', () => {
  it('ESC[K 擦除光标到行尾', () => {
    // 光标在第 5 格（退两格），擦掉光标位置到行尾，保留 abcd
    assert.equal(restore('abcdef\b\b\x1b[K\n').text, 'abcd');
  });

  it('ESC[1K 擦除行首到光标（含光标）', () => {
    // 光标在第 5 格（退两格），擦掉 0..4 共 5 格，保留位置 5 的 f
    assert.equal(restore('abcdef\b\b\x1b[1K\n').text, '     f');
  });

  it('ESC[2K 擦除整行后重写', () => {
    assert.equal(restore('abcdef\x1b[2K\rnew\n').text, 'new');
  });
});

describe('SGR 颜色', () => {
  it('颜色样式序列被忽略，文本保留', () => {
    assert.equal(restore('\x1b[31mred\x1b[0m \x1b[1;32mgreen\x1b[0m\n').text, 'red green');
  });
});

describe('跨块处理', () => {
  it('颜色序列被拆在多个块中仍被识别', () => {
    // 1 字节一块
    const r = restoreStringByBytes('\x1b[31mOK\x1b[0m\n', 1);
    assert.equal(r.text, 'OK');
    assert.deepEqual(r.diagnostics, []);
  });

  it('中文按 1 字节切块不解坏', () => {
    const r = restoreStringByBytes('进度100%完成\r\n第二行中文\n', 1);
    assert.equal(r.text, '进度100%完成\n第二行中文');
  });

  it('中文按 2、3 字节切块', () => {
    const s = '中文进度\r\n覆盖中文\n';
    for (const size of [2, 3, 5, 7]) {
      assert.equal(restoreStringByBytes(s, size).text, '中文进度\n覆盖中文');
    }
  });

  it('不同块大小得到相同结果', () => {
    const s = 'working\r\x1b[Kdone\r\n进度 0%\r进度 50%\r进度 100%\x1b[0m\n';
    const expected = restore(s).text;
    for (const size of [1, 2, 3, 4, 8, 16, 64, 4096]) {
      assert.equal(restoreStringByBytes(s, size).text, expected);
    }
  });

  it('Utf8Decoder 直接增量使用', () => {
    const dec = new Utf8Decoder();
    const buf = Buffer.from('中A文', 'utf8');
    let out = '';
    for (let i = 0; i < buf.length; i++) out += dec.write(buf.subarray(i, i + 1));
    dec.finish();
    assert.equal(out, '中A文');
  });
});

describe('未支持指令与不完整序列诊断', () => {
  it('文件末尾半截转义产生 INCOMPLETE_ESCAPE 诊断', () => {
    const r = restore('hello\x1b[31');
    assert.equal(r.text, 'hello');
    assert.ok(r.diagnostics.some((d) => d.code === 'INCOMPLETE_ESCAPE'));
  });

  it('半截 ESC 单独出现在末尾', () => {
    const r = restoreStringByBytes('abc\x1b', 1);
    assert.equal(r.text, 'abc');
    assert.ok(r.diagnostics.some((d) => d.code === 'INCOMPLETE_ESCAPE'));
  });

  it('不支持的光标移动产生 UNSUPPORTED_CSI 诊断', () => {
    const r = restore('a\x1b[3Db\n');
    assert.equal(r.text, 'ab');
    assert.ok(r.diagnostics.some((d) => d.code === 'UNSUPPORTED_CSI'));
  });

  it('OSC 标题序列产生诊断并被忽略', () => {
    const r = restore('\x1b]0;title\x07prompt\n');
    assert.equal(r.text, 'prompt');
    assert.ok(r.diagnostics.some((d) => d.code === 'UNSUPPORTED_ESCAPE'));
  });

  it('非法 UTF-8 返回 error 级诊断', () => {
    const r = restoreBufferChunks([Buffer.from([0x61, 0xff, 0x62])]);
    assert.equal(r.text, '');
    assert.equal(r.diagnostics[0].code, 'INVALID_UTF8');
    assert.equal(r.diagnostics[0].severity, 'error');
  });

  it('跨块的不完整 UTF-8 到末尾报错', () => {
    const r = restoreBufferChunks([Buffer.from([0x61]), Buffer.from([0xe4, 0xbd])]);
    assert.equal(r.diagnostics[0].code, 'INVALID_UTF8');
    assert.equal(r.diagnostics[0].severity, 'error');
  });
});

describe('Parser 直接增量写入', () => {
  it('多次 write 与一次写入结果一致', () => {
    const p = new Parser();
    p.write('wor');
    p.write('king\r\x1b');
    p.write('[K');
    p.write('done\n');
    assert.equal(p.finish().text, 'done');
  });
});
