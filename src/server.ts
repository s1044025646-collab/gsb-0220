import http from "node:http";
import path from "node:path";
import { Store } from "./store.js";
import { reduceFile, ChunkSession, DEFAULT_CHUNK_SIZE } from "./convert.js";
import { reduceText } from "./reducer.js";

export const DATA_DIR = process.env.DATA_DIR ?? path.join(process.cwd(), "data");

type Err = { code: string; message: string };

function send(res: http.ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) {
  const isText = typeof body === "string";
  res.writeHead(status, {
    "content-type": isText ? "text/plain; charset=utf-8" : "application/json; charset=utf-8",
    ...headers,
  });
  res.end(isText ? body : JSON.stringify(body));
}

function fail(res: http.ServerResponse, status: number, code: string, message: string) {
  send(res, status, { error: { code, message } });
}

async function readBody(req: http.IncomingMessage): Promise<any> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  if (chunks.length === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw Object.assign(new Error("请求体不是合法 JSON"), { code: "INVALID_ARGUMENT" });
  }
}

function requireString(v: unknown, name: string): string {
  if (typeof v !== "string") throw Object.assign(new Error(`参数 ${name} 必须是字符串`), { code: "INVALID_ARGUMENT" });
  return v;
}

export function createServer(store: Store) {
  const sessions = new Map<number, ChunkSession>();
  let nextSession = 1;

  return http.createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const parts = url.pathname.split("/").filter(Boolean);
    try {
      // POST /api/conversions  {name?, content} 一次性转换
      // POST /api/conversions  {name?, filePath, chunkSize?} 从文件转换
      if (req.method === "POST" && parts.length === 2 && parts[1] === "conversions") {
        const body = await readBody(req);
        const name = typeof body.name === "string" && body.name ? body.name : `conversion-${Date.now()}`;
        if (typeof body.filePath === "string") {
          const chunkSize = body.chunkSize ?? DEFAULT_CHUNK_SIZE;
          const { text, diagnostics, raw } = await reduceFile(body.filePath, chunkSize);
          const row = store.save({ name, source: `file:${body.filePath}`, raw, result: text, diagnostics });
          return send(res, 201, row);
        }
        const content = requireString(body.content, "content");
        const { text, diagnostics } = reduceText([content]);
        const row = store.save({ name, source: "api", raw: content, result: text, diagnostics });
        return send(res, 201, row);
      }

      // POST /api/sessions {name?} 开启分块会话
      if (req.method === "POST" && parts.length === 2 && parts[1] === "sessions") {
        const body = await readBody(req);
        const id = nextSession++;
        sessions.set(id, new ChunkSession());
        return send(res, 201, { sessionId: id, name: body.name ?? null });
      }

      // POST /api/sessions/:id/chunks {data: base64}
      if (req.method === "POST" && parts.length === 4 && parts[1] === "sessions" && parts[3] === "chunks") {
        const s = sessions.get(Number(parts[2]));
        if (!s) return fail(res, 404, "NOT_FOUND", "会话不存在或已结束");
        const body = await readBody(req);
        s.feedBase64(requireString(body.data, "data"));
        return send(res, 200, { ok: true });
      }

      // POST /api/sessions/:id/finalize {name?}
      if (req.method === "POST" && parts.length === 4 && parts[1] === "sessions" && parts[3] === "finalize") {
        const sid = Number(parts[2]);
        const s = sessions.get(sid);
        if (!s) return fail(res, 404, "NOT_FOUND", "会话不存在或已结束");
        const body = await readBody(req);
        sessions.delete(sid);
        const { text, diagnostics, raw } = s.finalize();
        const row = store.save({ name: body.name ?? `session-${sid}`, source: "api-chunks", raw, result: text, diagnostics });
        return send(res, 201, row);
      }

      // GET /api/conversions 列表
      if (req.method === "GET" && parts.length === 2 && parts[1] === "conversions") {
        return send(res, 200, store.list());
      }

      // GET /api/conversions/:id[/raw|/result|/diagnostics|/export]
      if (req.method === "GET" && parts.length >= 3 && parts[1] === "conversions") {
        const id = Number(parts[2]);
        if (!Number.isInteger(id)) return fail(res, 400, "INVALID_ARGUMENT", "id 必须是整数");
        const row = store.get(id);
        if (!row) return fail(res, 404, "NOT_FOUND", `记录 ${id} 不存在`);
        const sub = parts[3];
        if (!sub) return send(res, 200, row);
        if (sub === "raw") return send(res, 200, row.raw);
        if (sub === "result") return send(res, 200, row.result);
        if (sub === "diagnostics") return send(res, 200, row.diagnostics);
        if (sub === "export") {
          return send(res, 200, row.result, { "content-disposition": `attachment; filename="conversion-${id}.txt"` });
        }
        return fail(res, 404, "NOT_FOUND", "未知子资源");
      }

      return fail(res, 404, "NOT_FOUND", "路由不存在");
    } catch (e: any) {
      const code = e?.code ?? "INTERNAL";
      const status = code === "INVALID_ARGUMENT" ? 400 : code === "NOT_FOUND" ? 404 : 500;
      return fail(res, status, code, e?.message ?? "内部错误");
    }
  });
}

/** 启动服务；port=0 或未指定时自动选择空闲端口 */
export function startServer(port = Number(process.env.PORT ?? 0), dataDir = DATA_DIR): Promise<{ port: number; close: () => void }> {
  const store = new Store(dataDir);
  const server = createServer(store);
  return new Promise((resolve, reject) => {
    server.on("error", reject);
    server.listen(port, "127.0.0.1", () => {
      const addr = server.address();
      const actual = typeof addr === "object" && addr ? addr.port : port;
      resolve({ port: actual, close: () => { server.close(); store.close(); } });
    });
  });
}

// 直接运行：node dist/src/server.js [--port N]
if (process.argv[1] && import.meta.url === new URL(`file://${path.resolve(process.argv[1])}`).href) {
  const idx = process.argv.indexOf("--port");
  const port = idx >= 0 ? Number(process.argv[idx + 1]) : Number(process.env.PORT ?? 0);
  if (Number.isNaN(port) || port < 0 || port > 65535) {
    console.error("无效端口");
    process.exit(2);
  }
  startServer(port).then(({ port }) => {
    console.log(`服务已启动: http://127.0.0.1:${port}  数据目录: ${DATA_DIR}`);
  });
}
