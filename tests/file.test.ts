import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { reduceFile } from "../src/convert.js";
import { reduceText } from "../src/reducer.js";

test("UTF-8 中文按字节分块读取不被拆坏，且与块大小无关", async () => {
  const content = "进度：中文内容 10%\r进度：中文内容 99%\r完成：全部中文行 ✓\n第二行：你好世界\n";
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "reducer-"));
  const file = path.join(dir, "中文日志.log");
  fs.writeFileSync(file, content, "utf8");

  const expected = reduceText([content]).text;
  for (const chunkSize of [1, 2, 3, 4, 5, 7, 1024]) {
    const { text, raw, diagnostics } = await reduceFile(file, chunkSize);
    assert.equal(text, expected, `chunkSize=${chunkSize}`);
    assert.equal(raw, content, "原始内容保持不变");
    assert.equal(diagnostics.length, 0);
  }
});

test("非法 chunkSize 报错", async () => {
  await assert.rejects(() => reduceFile("x.log", 0), /chunkSize/);
});
