import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export type ConvertStatus = 'ok' | 'warning' | 'error';

export interface RecordRow {
  id: number;
  name: string;
  status: ConvertStatus;
  chunk_size: number;
  input_bytes: number;
  created_at: string;
  error_message: string | null;
}

export interface RecordDetail extends RecordRow {
  raw: string;
  result: string | null;
}

export interface DiagnosticRow {
  record_id: number;
  seq: number;
  code: string;
  severity: 'warning' | 'error';
  message: string;
  offset: number;
  raw: string | null;
}

export function openDatabase(dbPath: string): DatabaseSync {
  mkdirSync(dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec(`
    CREATE TABLE IF NOT EXISTS records (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('ok','warning','error')),
      chunk_size INTEGER NOT NULL,
      input_bytes INTEGER NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      error_message TEXT,
      raw TEXT NOT NULL,
      result TEXT
    );
    CREATE TABLE IF NOT EXISTS diagnostics (
      record_id INTEGER NOT NULL REFERENCES records(id) ON DELETE CASCADE,
      seq INTEGER NOT NULL,
      code TEXT NOT NULL,
      severity TEXT NOT NULL,
      message TEXT NOT NULL,
      offset INTEGER NOT NULL,
      raw TEXT,
      PRIMARY KEY (record_id, seq)
    );
  `);
  return db;
}

export function listRecords(db: DatabaseSync, limit = 50): RecordRow[] {
  return db
    .prepare(
      `SELECT id, name, status, chunk_size, input_bytes, created_at, error_message
       FROM records ORDER BY id DESC LIMIT ?`,
    )
    .all(limit) as unknown as RecordRow[];
}

export function getRecord(db: DatabaseSync, id: number): RecordDetail | null {
  return (
    (db
      .prepare('SELECT id, name, status, chunk_size, input_bytes, created_at, error_message, raw, result FROM records WHERE id = ?')
      .get(id) as RecordDetail | undefined) ?? null
  );
}

export function getDiagnostics(db: DatabaseSync, id: number): DiagnosticRow[] {
  return db
    .prepare('SELECT record_id, seq, code, severity, message, offset, raw FROM diagnostics WHERE record_id = ? ORDER BY seq')
    .all(id) as unknown as DiagnosticRow[];
}

export interface InsertParams {
  name: string;
  status: ConvertStatus;
  chunkSize: number;
  inputBytes: number;
  raw: string;
  result: string | null;
  errorMessage: string | null;
  diagnostics: Array<{ code: string; severity: 'warning' | 'error'; message: string; offset: number; raw?: string }>;
}

export function insertRecord(db: DatabaseSync, p: InsertParams): number {
  const tx = db.prepare(
    `INSERT INTO records (name, status, chunk_size, input_bytes, raw, result, error_message)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  );
  const info = tx.run(p.name, p.status, p.chunkSize, p.inputBytes, p.raw, p.result, p.errorMessage);
  const id = Number(info.lastInsertRowid);
  const ins = db.prepare(
    'INSERT INTO diagnostics (record_id, seq, code, severity, message, offset, raw) VALUES (?, ?, ?, ?, ?, ?, ?)',
  );
  p.diagnostics.forEach((d, i) => ins.run(id, i, d.code, d.severity, d.message, d.offset, d.raw ?? null));
  return id;
}
