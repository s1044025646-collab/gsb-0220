import { test } from "node:test";
import assert from "node:assert/strict";
import { reduceText, Reducer } from "../src/reducer.js";

function reduceInChunks(input: string, size: number) {
  const cps = [...input];
  const r = new Reducer();
  for (let i = 0; i < cps.length; i += size) r.feed(cps.slice(i, i + size).join(""));
  return r.finalize();
}

test("CRLF 正常换行", () => {
  const { text, diagnostics } = reduceText(["line1\r\nline2\r\n"]);
  assert.equal(text, "line1\nline2\n");
  assert.equal(diagnostics.length, 0);
});

test("回车覆盖：普通字符写入光标位置", () => {
  assert.equal(reduceText(["abcdef\rxy\n"]).text, "xycdef\n");
});

test("退格只移动光标，后续写入覆盖", () => {
  assert.equal(reduceText(["hellp\bo\n"]).text, "hello\n");
  assert.equal(reduceText(["hellp\b\boX\n"]).text, "heloX\n");
  assert.equal(reduceText(["abc\b\n"]).text, "abc\n");
});

test("SGR 颜色序列被忽略", () => {
  assert.equal(reduceText(["\x1b[1;31m红色\x1b[0m 正常\n"]).text, "红色 正常\n");
});

test("CSI 0 K 擦除光标到行尾", () => {
  assert.equal(reduceText(["abcdef\rxy\x1b[0K\n"]).text, "xy\n");
  assert.equal(reduceText(["abcdef\rxy\x1b[K\n"]).text, "xy\n");
});

test("CSI 1 K 擦除行首到光标", () => {
  assert.equal(reduceText(["abcdef\rabc\x1b[1K\n"]).text, "   def\n");
});

test("CSI 2 K 擦除整行", () => {
  assert.equal(reduceText(["abcdef\r\x1b[2Kxy\n"]).text, "xy\n");
});

test("转义序列拆在多个块中仍正确识别", () => {
  const input = "abc\x1b[32m绿\x1b[0m\r\x1b[Kz\n";
  for (const size of [1, 2, 3, 5, 100]) {
    assert.equal(reduceInChunks(input, size).text, "z\n", `chunkSize=${size}`);
  }
});

test("同一输入不同块大小结果相同", () => {
  const input = "进度 10%\r进度 88%\r完成 ✓\n第二行 abc\b\bXY\n";
  const expected = reduceText([input]).text;
  for (const size of [1, 2, 3, 7, 13]) {
    assert.equal(reduceInChunks(input, size).text, expected, `chunkSize=${size}`);
  }
});

test("文件末尾半截转义序列产生诊断", () => {
  const { diagnostics } = reduceText(["abc\x1b[3"]);
  assert.equal(diagnostics.length, 1);
  assert.equal(diagnostics[0].code, "UNTERMINATED_ESCAPE");
});

test("未支持的光标移动序列产生诊断", () => {
  const { text, diagnostics } = reduceText(["a\x1b[2Ab\n"]);
  assert.equal(text, "ab\n");
  assert.equal(diagnostics.length, 1);
  assert.equal(diagnostics[0].code, "UNSUPPORTED_ESCAPE");
});

test("未支持的控制字符产生诊断", () => {
  const { diagnostics } = reduceText(["a\x07b\n"]);
  assert.equal(diagnostics[0].code, "UNSUPPORTED_CONTROL");
});
