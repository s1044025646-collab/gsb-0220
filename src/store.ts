import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import path from "node:path";
import type { Diagnostic } from "./reducer.js";

export interface ConversionRow {
  id: number;
  name: string;
  source: string;
  status: "ok" | "failed";
  created_at: string;
  raw: string;
  result: string;
  diagnostics: Diagnostic[];
}

export class Store {
  private db: DatabaseSync;

  constructor(dataDir: string) {
    mkdirSync(dataDir, { recursive: true });
    this.db = new DatabaseSync(path.join(dataDir, "conversions.db"));
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS conversions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        source TEXT NOT NULL,
        status TEXT NOT NULL,
        created_at TEXT NOT NULL,
        raw TEXT NOT NULL,
        result TEXT NOT NULL,
        diagnostics TEXT NOT NULL
      )`);
  }

  save(input: { name: string; source: string; raw: string; result: string; diagnostics: Diagnostic[] }): ConversionRow {
    const status = input.diagnostics.length === 0 ? "ok" : "failed";
    const stmt = this.db.prepare(
      "INSERT INTO conversions (name, source, status, created_at, raw, result, diagnostics) VALUES (?,?,?,?,?,?,?)"
    );
    const r = stmt.run(
      input.name, input.source, status, new Date().toISOString(),
      input.raw, input.result, JSON.stringify(input.diagnostics)
    );
    return this.get(Number(r.lastInsertRowid))!;
  }

  get(id: number): ConversionRow | null {
    const row = this.db.prepare("SELECT * FROM conversions WHERE id = ?").get(id) as any;
    return row ? this.map(row) : null;
  }

  list(): Omit<ConversionRow, "raw" | "result">[] {
    const rows = this.db.prepare("SELECT id, name, source, status, created_at, diagnostics FROM conversions ORDER BY id DESC").all() as any[];
    return rows.map((r) => ({ ...r, diagnostics: JSON.parse(r.diagnostics) }));
  }

  private map(row: any): ConversionRow {
    return { ...row, diagnostics: JSON.parse(row.diagnostics) };
  }

  close(): void {
    this.db.close();
  }
}
