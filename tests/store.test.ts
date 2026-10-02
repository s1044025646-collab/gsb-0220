import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Store } from "../src/store.js";
import { reduceText } from "../src/reducer.js";

test("保存后重启（重新打开数据库）仍可查看原文、结果与诊断", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "store-"));
  const raw = "abc\x1b[2Jdef\n";
  const { text, diagnostics } = reduceText([raw]);

  let store = new Store(dir);
  const saved = store.save({ name: "t1", source: "test", raw, result: text, diagnostics });
  assert.equal(saved.status, "failed", "带诊断的转换不能记为成功");
  store.close();

  store = new Store(dir);
  const row = store.get(saved.id)!;
  assert.equal(row.raw, raw);
  assert.equal(row.result, text);
  assert.equal(row.diagnostics.length, 1);
  assert.equal(row.diagnostics[0].code, "UNSUPPORTED_ESCAPE");
  assert.equal(store.list().length, 1);
  store.close();
});

test("无诊断的转换记为 ok", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "store-"));
  const store = new Store(dir);
  const { text, diagnostics } = reduceText(["hello\n"]);
  const row = store.save({ name: "t2", source: "test", raw: "hello\n", result: text, diagnostics });
  assert.equal(row.status, "ok");
  store.close();
});
