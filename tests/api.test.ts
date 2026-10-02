import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { startServer } from "../src/server.js";

let port: number;
let close: () => void;

before(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "api-"));
  ({ port, close } = await startServer(0, dir));
});
after(() => close());

const url = (p: string) => `http://127.0.0.1:${port}${p}`;

test("一次性转换 API", async () => {
  const res = await fetch(url("/api/conversions"), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "api-test", content: "abcdef\rxy\x1b[K\n" }),
  });
  assert.equal(res.status, 201);
  const row = await res.json();
  assert.equal(row.result, "xy\n");
  assert.equal(row.status, "ok");

  const got = await (await fetch(url(`/api/conversions/${row.id}`))).json();
  assert.equal(got.raw, "abcdef\rxy\x1b[K\n");

  const list = await (await fetch(url("/api/conversions"))).json();
  assert.ok(list.some((r: any) => r.id === row.id));

  const exported = await (await fetch(url(`/api/conversions/${row.id}/export`))).text();
  assert.equal(exported, "xy\n");
});

test("分块会话 API（跨块中文与转义序列）", async () => {
  const s = await (await fetch(url("/api/sessions"), { method: "POST", body: "{}" })).json();
  const buf = Buffer.from("进度 50%\r\x1b[32m完成 ✓\x1b[0m\x1b[K\n", "utf8");
  for (let i = 0; i < buf.length; i += 3) {
    const r = await fetch(url(`/api/sessions/${s.sessionId}/chunks`), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ data: buf.subarray(i, i + 3).toString("base64") }),
    });
    assert.equal(r.status, 200);
  }
  const fin = await fetch(url(`/api/sessions/${s.sessionId}/finalize`), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "chunked" }),
  });
  assert.equal(fin.status, 201);
  const row = await fin.json();
  assert.equal(row.result, "完成 ✓\n");
  assert.equal(row.status, "ok");
});

test("错误码：参数校验与 404", async () => {
  const bad = await fetch(url("/api/conversions"), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({}),
  });
  assert.equal(bad.status, 400);
  assert.equal((await bad.json()).error.code, "INVALID_ARGUMENT");

  const nf = await fetch(url("/api/conversions/99999"));
  assert.equal(nf.status, 404);
  assert.equal((await nf.json()).error.code, "NOT_FOUND");
});
