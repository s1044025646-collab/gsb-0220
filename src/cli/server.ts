import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { basename, join } from 'node:path';
import { createServer as createNet } from 'node:net';
import { openDatabase } from '../db.js';
import {
  appendChunk,
  convertAndSave,
  finishChunkSession,
  queryDiagnostics,
  queryRecordDetail,
  queryRecords,
  setSessionDb,
  startChunkSession,
  ValidationError,
} from '../service.js';
import type { DatabaseSync } from 'node:sqlite';

export interface ServeOptions {
  dataDir: string;
  port: number; // 0 表示自动选择空闲端口
}

function pickFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createNet();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      srv.close(() => resolve(typeof addr === 'object' && addr ? addr.port : 0));
    });
  });
}

async function readJson(req: IncomingMessage, maxBytes = 21 * 1024 * 1024): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > maxBytes) throw new ValidationError('BODY_TOO_LARGE', '请求体超过大小上限');
    chunks.push(chunk as Buffer);
  }
  if (chunks.length === 0) throw new ValidationError('INVALID_BODY', '请求体为空');
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new ValidationError('INVALID_JSON', '请求体不是合法 JSON');
  }
}

function send(res: ServerResponse, status: number, body: unknown): void {
  const json = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(json);
}

export async function startServe(options: ServeOptions): Promise<{ server: Server; port: number; db: DatabaseSync }> {
  const db = openDatabase(join(options.dataDir, 'restorer.db'));
  setSessionDb(db);

  const server = createServer((req, res) => {
    void handle(req, res, db);
  });

  const port = options.port === 0 ? await pickFreePort() : options.port;
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolve);
  });
  return { server, port: (server.address() as { port: number }).port, db };
}

async function handle(req: IncomingMessage, res: ServerResponse, db: DatabaseSync): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://127.0.0.1');
  const path = url.pathname;
  const method = req.method ?? 'GET';
  try {
    if (method === 'GET' && path === '/health') {
      send(res, 200, { ok: true });
      return;
    }
    if (method === 'POST' && path === '/api/convert') {
      const body = await readJson(req);
      send(res, 200, convertAndSave(db, body));
      return;
    }
    if (method === 'POST' && path === '/api/chunk-sessions') {
      const body = await readJson(req);
      send(res, 201, startChunkSession(body));
      return;
    }
    const appendMatch = path.match(/^\/api\/chunk-sessions\/(\d+)\/chunks$/);
    if (method === 'POST' && appendMatch) {
      const body = (await readJson(req)) as { chunk?: unknown };
      send(res, 200, appendChunk(appendMatch[1], body.chunk));
      return;
    }
    const finishMatch = path.match(/^\/api\/chunk-sessions\/(\d+)\/finish$/);
    if (method === 'POST' && finishMatch) {
      send(res, 200, finishChunkSession(finishMatch[1]));
      return;
    }
    if (method === 'GET' && path === '/api/records') {
      const limit = Number(url.searchParams.get('limit') ?? '50');
      if (!Number.isInteger(limit) || limit < 1 || limit > 500) {
        throw new ValidationError('INVALID_LIMIT', 'limit 必须是 1–500 的整数');
      }
      send(res, 200, { records: queryRecords(db, limit) });
      return;
    }
    const recordMatch = path.match(/^\/api\/records\/(\d+)$/);
    if (method === 'GET' && recordMatch) {
      send(res, 200, queryRecordDetail(db, Number(recordMatch[1])));
      return;
    }
    const diagMatch = path.match(/^\/api\/records\/(\d+)\/diagnostics$/);
    if (method === 'GET' && diagMatch) {
      send(res, 200, { diagnostics: queryDiagnostics(db, Number(diagMatch[1])) });
      return;
    }
    const exportMatch = path.match(/^\/api\/records\/(\d+)\/export$/);
    if (method === 'GET' && exportMatch) {
      const record = queryRecordDetail(db, Number(exportMatch[1]));
      if (record.result === null) throw new ValidationError('NO_RESULT', '该记录为失败转换，没有可导出的文本');
      res.writeHead(200, {
        'content-type': 'text/plain; charset=utf-8',
        'content-disposition': `attachment; filename="record-${record.id}.txt"`,
      });
      res.end(record.result);
      return;
    }
    send(res, 404, { error: { code: 'NOT_FOUND', message: `没有该路由: ${method} ${path}` } });
  } catch (err) {
    if (err instanceof ValidationError) {
      const status = err.code === 'NOT_FOUND' ? 404 : 400;
      send(res, status, { error: { code: err.code, message: err.message } });
      return;
    }
    send(res, 500, { error: { code: 'INTERNAL', message: (err as Error).message } });
  }
}

function parseArgs(argv: string[]): { dataDir: string; port: number } {
  let dataDir = join(process.cwd(), 'data');
  let port = 0;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--data-dir' && argv[i + 1]) dataDir = argv[++i];
    else if (argv[i] === '--port' && argv[i + 1]) {
      port = Number(argv[++i]);
      if (!Number.isInteger(port) || port < 0 || port > 65535) {
        console.error('错误: --port 必须是 0–65535 的整数（0 表示自动选择空闲端口）');
        process.exit(2);
      }
    } else {
      console.error(`未知参数: ${argv[i]}`);
      process.exit(2);
    }
  }
  return { dataDir, port };
}

if (process.argv[1] && basename(process.argv[1]) === 'server.js') {
  const args = parseArgs(process.argv.slice(2));
  startServe(args).then(({ port }) => {
    console.log(`终端输出整理服务已启动: http://127.0.0.1:${port}`);
    console.log(`数据目录: ${args.dataDir}`);
  });
}
