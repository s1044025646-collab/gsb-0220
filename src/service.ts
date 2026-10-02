import { readFileSync } from 'node:fs';
import type { DatabaseSync } from 'node:sqlite';
import { restoreBufferChunks } from './parser.js';
import {
  getDiagnostics,
  getRecord,
  insertRecord,
  listRecords,
  type ConvertStatus,
  type DiagnosticRow,
  type RecordDetail,
  type RecordRow,
} from './db.js';

export class ValidationError extends Error {
  readonly code: string;
  constructor(
    code: string,
    message: string,
  ) {
    super(message);
    this.name = 'ValidationError';
    this.code = code;
  }
}

const MAX_BYTES = 20 * 1024 * 1024;

export interface ConvertInput {
  name: string;
  content?: string | undefined;
  filePath?: string | undefined;
  /** 分块读取的字节块大小，1–1MB，默认 4096 */
  chunkSize: number;
}

export interface ConvertOutput {
  id: number;
  status: ConvertStatus;
  result: string | null;
  diagnostics: Array<{
    code: string;
    severity: 'warning' | 'error';
    message: string;
    offset: number;
    raw?: string;
  }>;
}

function validateConvertInput(input: unknown): ConvertInput {
  if (typeof input !== 'object' || input === null) {
    throw new ValidationError('INVALID_BODY', '请求体必须是 JSON 对象');
  }
  const obj = input as Record<string, unknown>;
  const name = obj.name ?? 'inline';
  if (typeof name !== 'string' || name.length === 0 || name.length > 200) {
    throw new ValidationError('INVALID_NAME', 'name 必须是 1–200 字符的字符串');
  }
  if (obj.content !== undefined && typeof obj.content !== 'string') {
    throw new ValidationError('INVALID_CONTENT', 'content 必须是字符串');
  }
  if (obj.filePath !== undefined && typeof obj.filePath !== 'string') {
    throw new ValidationError('INVALID_FILE_PATH', 'filePath 必须是字符串');
  }
  if (obj.content === undefined && obj.filePath === undefined) {
    throw new ValidationError('MISSING_SOURCE', '必须提供 content 或 filePath');
  }
  let chunkSize = 4096;
  if (obj.chunkSize !== undefined) {
    if (typeof obj.chunkSize !== 'number' || !Number.isInteger(obj.chunkSize)) {
      throw new ValidationError('INVALID_CHUNK_SIZE', 'chunkSize 必须是整数');
    }
    chunkSize = obj.chunkSize;
  }
  if (chunkSize < 1 || chunkSize > 1024 * 1024) {
    throw new ValidationError('INVALID_CHUNK_SIZE', 'chunkSize 必须在 1 到 1048576 之间');
  }
  return { name, content: obj.content as string | undefined, filePath: obj.filePath as string | undefined, chunkSize };
}

export function chunkBuffer(buf: Buffer, chunkSize: number): Buffer[] {
  const chunks: Buffer[] = [];
  for (let i = 0; i < buf.length; i += chunkSize) chunks.push(buf.subarray(i, i + chunkSize));
  return chunks;
}

export function convertAndSave(db: DatabaseSync, rawInput: unknown): ConvertOutput {
  const input = validateConvertInput(rawInput);
  let buffer: Buffer;
  let displayName: string;
  if (input.filePath !== undefined) {
    let read: Buffer;
    try {
      read = readFileSync(input.filePath);
    } catch (err) {
      throw new ValidationError('FILE_READ_FAILED', `无法读取文件: ${(err as Error).message}`);
    }
    buffer = read;
    displayName = input.name === 'inline' ? input.filePath : input.name!;
  } else {
    buffer = Buffer.from(input.content!, 'utf8');
    displayName = input.name!;
  }
  if (buffer.length > MAX_BYTES) {
    throw new ValidationError('INPUT_TOO_LARGE', `输入超过 ${MAX_BYTES} 字节上限`);
  }

  const parsed = restoreBufferChunks(chunkBuffer(buffer, input.chunkSize!));
  const hasError = parsed.diagnostics.some((d) => d.severity === 'error');
  const status: ConvertStatus = hasError
    ? 'error'
    : parsed.diagnostics.length > 0
      ? 'warning'
      : 'ok';

  const id = insertRecord(db, {
    name: displayName,
    status,
    chunkSize: input.chunkSize!,
    inputBytes: buffer.length,
    raw: buffer.toString('utf8'),
    result: hasError ? null : parsed.text,
    errorMessage: hasError ? parsed.diagnostics.find((d) => d.severity === 'error')!.message : null,
    diagnostics: parsed.diagnostics,
  });

  return {
    id,
    status,
    result: hasError ? null : parsed.text,
    diagnostics: parsed.diagnostics.map((d) => ({ ...d })),
  };
}

export interface ChunkSession {
  id: number;
  name: string;
  chunkSize: number;
  chunks: Buffer[];
}

/**
 * 分块输入会话。分块是 HTTP 层面的任意切分，保存时仍按 chunkSize 重新切分，
 * 保证“同内容不同块大小结果一致”这一不变量可测试。
 */
const sessions = new Map<number, ChunkSession>();
let nextSession = 1;

export function startChunkSession(input: unknown): { sessionId: number } {
  if (typeof input !== 'object' || input === null) throw new ValidationError('INVALID_BODY', '请求体必须是 JSON 对象');
  const obj = input as Record<string, unknown>;
  const name = obj.name;
  if (typeof name !== 'string' || name.length === 0 || name.length > 200) {
    throw new ValidationError('INVALID_NAME', 'name 必须是 1–200 字符的字符串');
  }
  let chunkSize = 4096;
  if (obj.chunkSize !== undefined) {
    if (typeof obj.chunkSize !== 'number' || !Number.isInteger(obj.chunkSize) || obj.chunkSize < 1 || obj.chunkSize > 1024 * 1024) {
      throw new ValidationError('INVALID_CHUNK_SIZE', 'chunkSize 必须是 1 到 1048576 之间的整数');
    }
    chunkSize = obj.chunkSize;
  }
  const sessionId = nextSession++;
  sessions.set(sessionId, { id: sessionId, name, chunkSize, chunks: [] });
  return { sessionId };
}

export function appendChunk(sessionId: unknown, chunkBase64: unknown): { receivedBytes: number } {
  const id = typeof sessionId === 'number' ? sessionId : Number(sessionId);
  const session = sessions.get(id);
  if (!session) throw new ValidationError('SESSION_NOT_FOUND', `会话 ${id} 不存在`);
  if (typeof chunkBase64 !== 'string') throw new ValidationError('INVALID_CHUNK', 'chunk 必须是 Base64 字符串');
  let chunk: Buffer;
  try {
    chunk = Buffer.from(chunkBase64, 'base64');
  } catch {
    throw new ValidationError('INVALID_CHUNK', 'chunk 不是合法的 Base64');
  }
  session.chunks.push(chunk);
  return { receivedBytes: session.chunks.reduce((n, c) => n + c.length, 0) };
}

export function finishChunkSession(sessionId: unknown): ConvertOutput {
  const id = typeof sessionId === 'number' ? sessionId : Number(sessionId);
  const session = sessions.get(id);
  if (!session) throw new ValidationError('SESSION_NOT_FOUND', `会话 ${id} 不存在`);
  sessions.delete(id);
  const buffer = Buffer.concat(session.chunks);
  if (buffer.length > MAX_BYTES) throw new ValidationError('INPUT_TOO_LARGE', `输入超过 ${MAX_BYTES} 字节上限`);
  const parsed = restoreBufferChunks(chunkBuffer(buffer, session.chunkSize));
  const hasError = parsed.diagnostics.some((d) => d.severity === 'error');
  const status: ConvertStatus = hasError ? 'error' : parsed.diagnostics.length > 0 ? 'warning' : 'ok';
  const recordId = insertRecord(dbRef, {
    name: session.name,
    status,
    chunkSize: session.chunkSize,
    inputBytes: buffer.length,
    raw: buffer.toString('utf8'),
    result: hasError ? null : parsed.text,
    errorMessage: hasError ? parsed.diagnostics.find((d) => d.severity === 'error')!.message : null,
    diagnostics: parsed.diagnostics,
  });
  return {
    id: recordId,
    status,
    result: hasError ? null : parsed.text,
    diagnostics: parsed.diagnostics.map((d) => ({ ...d })),
  };
}

// finishChunkSession 与服务入口共用一个 db 句柄，由 setSessionDb 注入。
let dbRef!: DatabaseSync;
export function setSessionDb(db: DatabaseSync): void {
  dbRef = db;
}

export function queryRecords(db: DatabaseSync, limit: number): RecordRow[] {
  return listRecords(db, limit);
}

export function queryRecordDetail(db: DatabaseSync, id: number): RecordDetail {
  const row = getRecord(db, id);
  if (!row) throw new ValidationError('NOT_FOUND', `记录 ${id} 不存在`);
  return row;
}

export function queryDiagnostics(db: DatabaseSync, id: number): DiagnosticRow[] {
  if (!getRecord(db, id)) throw new ValidationError('NOT_FOUND', `记录 ${id} 不存在`);
  return getDiagnostics(db, id);
}
