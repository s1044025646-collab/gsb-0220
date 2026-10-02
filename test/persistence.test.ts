import assert from 'node:assert/strict';
import { after, describe, it } from 'node:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase } from '../dist/src/db.js';
import { convertAndSave, queryDiagnostics, queryRecordDetail, queryRecords } from '../dist/src/service.js';

const dir = mkdtempSync(join(tmpdir(), 'tor-test-'));
const dbPath = join(dir, 'restorer.db');

describe('SQLite 持久化与状态', () => {
  it('成功转换保存原文与结果', () => {
    const db = openDatabase(dbPath);
    const out = convertAndSave(db, { name: 't1', content: 'working\rdone\x1b[K\n', chunkSize: 1 });
    assert.equal(out.status, 'ok');
    const detail = queryRecordDetail(db, out.id);
    assert.equal(detail.raw, 'working\rdone\x1b[K\n');
    assert.equal(detail.result, 'done');
    db.close();
  });

  it('含未支持指令记为 warning 而非失败', () => {
    const db = openDatabase(dbPath);
    const out = convertAndSave(db, { name: 't2', content: 'a\x1b[3Db\n' });
    assert.equal(out.status, 'warning');
    assert.equal(out.diagnostics[0].code, 'UNSUPPORTED_CSI');
    const diags = queryDiagnostics(db, out.id);
    assert.equal(diags.length, 1);
    db.close();
  });

  it('非法 UTF-8 记为 error，结果为 null，不被记成成功', () => {
    const db = openDatabase(dbPath);
    const badFile = join(dir, 'bad.log');
    writeFileSync(badFile, Buffer.from([0x61, 0xff, 0x62]));
    const out = convertAndSave(db, { name: 't3', filePath: badFile });
    assert.equal(out.status, 'error');
    assert.equal(out.result, null);
    assert.equal(out.diagnostics[0].code, 'INVALID_UTF8');
    const detail = queryRecordDetail(db, out.id);
    assert.equal(detail.status, 'error');
    assert.equal(detail.result, null);
    assert.ok(detail.error_message);
    db.close();
  });

  it('历史列表可查到全部记录', () => {
    const db = openDatabase(dbPath);
    const records = queryRecords(db, 10);
    assert.ok(records.length >= 2);
    db.close();
  });
  it('关闭后重新打开数据库，原文、结果与诊断仍在', () => {
    const db = openDatabase(dbPath);
    const records = queryRecords(db, 10);
    const first = records.find((r) => r.name === 't1')!;
    const detail = queryRecordDetail(db, first.id);
    assert.equal(detail.result, 'done');
    assert.equal(detail.raw.includes('\r'), true);
    const warning = records.find((r) => r.name === 't2')!;
    const diags = queryDiagnostics(db, warning.id);
    assert.equal(diags[0].code, 'UNSUPPORTED_CSI');
    db.close();
  });

  it('不存在的记录抛出 NOT_FOUND', () => {
    const db = openDatabase(dbPath);
    assert.throws(
      () => queryRecordDetail(db, 99999),
      (err: unknown) => (err as { code?: string }).code === 'NOT_FOUND',
    );
    db.close();
  });

  after(() => {
    // Windows 上 SQLite WAL 文件偶尔短暂占用，重试清理。
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        rmSync(dir, { recursive: true, force: true });
        return;
      } catch {
        // busy retry
      }
    }
  });
});

describe('参数校验', () => {
  const valDir = mkdtempSync(join(tmpdir(), 'tor-val-'));
  const db = openDatabase(join(valDir, 'restorer.db'));

  function expectCode(fn: () => unknown, code: string): void {
    assert.throws(fn, (err: unknown) => (err as { code?: string }).code === code);
  }

  it('缺少来源报 MISSING_SOURCE', () => {
    expectCode(() => convertAndSave(db, { name: 'x' }), 'MISSING_SOURCE');
  });

  it('chunkSize 越界报错', () => {
    expectCode(() => convertAndSave(db, { name: 'x', content: 'a', chunkSize: 0 }), 'INVALID_CHUNK_SIZE');
    expectCode(() => convertAndSave(db, { name: 'x', content: 'a', chunkSize: 2_000_000 }), 'INVALID_CHUNK_SIZE');
  });

  it('读取不存在的文件报 FILE_READ_FAILED', () => {
    expectCode(
      () => convertAndSave(db, { filePath: join(valDir, 'definitely-not-exist.log') }),
      'FILE_READ_FAILED',
    );
  });

  after(() => {
    db.close();
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        rmSync(valDir, { recursive: true, force: true });
        return;
      } catch {
        // busy retry
      }
    }
  });
});
