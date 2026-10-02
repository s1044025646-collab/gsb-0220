#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { Store } from "./store.js";
import { reduceFile, DEFAULT_CHUNK_SIZE } from "./convert.js";
import { startServer, DATA_DIR } from "./server.js";

const args = process.argv.slice(2);
const cmd = args[0];

function opt(name: string): string | undefined {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
}

function usage(): never {
  console.log(`用法: node dist/src/cli.js <命令> [选项]

命令:
  serve [--port N]                 启动 HTTP API（默认自动选择空闲端口）
  convert <file> [--name N] [--chunk-size N]   转换日志文件并保存
  list                             列出历史记录
  show <id> [--raw|--result|--diag]  查看记录（默认显示元信息与诊断）
  export <id> [-o file]            导出纯文本结果（默认输出到 stdout）
  demo                             运行内置演示（进度覆盖 / 残留 vs 擦除）

数据目录: ${DATA_DIR}（可用环境变量 DATA_DIR 覆盖）`);
  process.exit(cmd ? 2 : 0);
}

async function main() {
  switch (cmd) {
    case "serve": {
      const port = opt("port") ? Number(opt("port")) : 0;
      if (Number.isNaN(port)) { console.error("错误: --port 必须是数字"); process.exit(2); }
      const { port: actual } = await startServer(port);
      console.log(`服务已启动: http://127.0.0.1:${actual}  数据目录: ${DATA_DIR}`);
      break;
    }
    case "convert": {
      const file = args[1];
      if (!file) usage();
      if (!fs.existsSync(file)) { console.error(`错误: 文件不存在: ${file}`); process.exit(2); }
      const chunkSize = opt("chunk-size") ? Number(opt("chunk-size")) : DEFAULT_CHUNK_SIZE;
      const store = new Store(DATA_DIR);
      const { text, diagnostics } = await reduceFile(file, chunkSize);
      const row = store.save({ name: opt("name") ?? path.basename(file), source: `file:${path.resolve(file)}`, raw: fs.readFileSync(file, "utf8"), result: text, diagnostics });
      store.close();
      console.log(`已保存记录 #${row.id}  状态: ${row.status}`);
      console.log("--- 还原结果 ---");
      console.log(row.result);
      if (row.diagnostics.length) {
        console.log("--- 诊断 ---");
        for (const d of row.diagnostics) console.log(`[${d.code}] offset=${d.offset} ${d.message}`);
      }
      break;
    }
    case "list": {
      const store = new Store(DATA_DIR);
      for (const r of store.list()) {
        console.log(`#${r.id}\t${r.status}\t${r.created_at}\t${r.name}\t(${r.source}, 诊断 ${r.diagnostics.length} 条)`);
      }
      store.close();
      break;
    }
    case "show": {
      const id = Number(args[1]);
      if (!Number.isInteger(id)) { console.error("错误: id 必须是整数"); process.exit(2); }
      const store = new Store(DATA_DIR);
      const row = store.get(id);
      store.close();
      if (!row) { console.error(`错误: 记录 ${id} 不存在`); process.exit(1); }
      if (args.includes("--raw")) console.log(row.raw);
      else if (args.includes("--result")) console.log(row.result);
      else if (args.includes("--diag")) console.log(JSON.stringify(row.diagnostics, null, 2));
      else {
        console.log(`#${row.id} ${row.name} [${row.status}] ${row.created_at} 来源: ${row.source}`);
        console.log(`诊断 ${row.diagnostics.length} 条`);
      }
      break;
    }
    case "export": {
      const id = Number(args[1]);
      if (!Number.isInteger(id)) { console.error("错误: id 必须是整数"); process.exit(2); }
      const store = new Store(DATA_DIR);
      const row = store.get(id);
      store.close();
      if (!row) { console.error(`错误: 记录 ${id} 不存在`); process.exit(1); }
      const out = opt("o");
      if (out) { fs.writeFileSync(out, row.result, "utf8"); console.log(`已导出到 ${out}`); }
      else process.stdout.write(row.result + "\n");
      break;
    }
    case "demo": {
      const { runDemo } = await import("./demo.js");
      await runDemo();
      break;
    }
    default:
      usage();
  }
}

main().catch((e) => { console.error(`错误: ${e.message}`); process.exit(1); });
