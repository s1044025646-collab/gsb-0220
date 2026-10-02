#!/usr/bin/env node
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { openDatabase } from '../db.js';
import { convertAndSave, queryDiagnostics, queryRecordDetail, queryRecords, ValidationError } from '../service.js';

function usage(): never {
  console.error(`终端输出回车覆盖与 ANSI 文本还原工具

用法:
  tor convert --file <日志文件> [--name <名称>] [--chunk-size <字节>]
  tor list [--limit <条数>]
  tor show <记录ID> [--raw|--result]
  tor diagnostics <记录ID>
  tor export <记录ID> [--out <文件>]

选项:
  --data-dir <目录>   数据目录（默认 ./data，也可用 TOR_DATA_DIR）
  --chunk-size <字节> 分块读取字节大小，1–1048576，默认 4096
`);
  process.exit(2);
}

interface ParsedArgs {
  command: string;
  positional: string[];
  options: Map<string, string>;
}

function parseArgs(argv: string[]): ParsedArgs {
  const [command, ...rest] = argv;
  if (!command) usage();
  const options = new Map<string, string>();
  const positional: string[] = [];
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a.startsWith('--')) {
      const value = rest[i + 1] && !rest[i + 1].startsWith('--') ? rest[++i] : '';
      options.set(a.slice(2), value);
    } else {
      positional.push(a);
    }
  }
  return { command, positional, options };
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  const dataDir = args.options.get('data-dir') ?? process.env.TOR_DATA_DIR ?? join(process.cwd(), 'data');
  const db = openDatabase(join(dataDir, 'restorer.db'));

  try {
    if (args.command === 'convert') {
      const file = args.options.get('file');
      if (!file) throw new ValidationError('MISSING_FILE', 'convert 需要 --file <日志文件>');
      const chunkSize = Number(args.options.get('chunk-size') ?? '4096');
      const out = convertAndSave(db, {
        filePath: file,
        name: args.options.get('name') ?? file,
        chunkSize: Number.isNaN(chunkSize) ? undefined : chunkSize,
      });
      console.log(`记录 #${out.id}  状态: ${out.status}`);
      if (out.result !== null) {
        console.log('---- 还原结果 ----');
        console.log(out.result);
      }
      if (out.diagnostics.length > 0) {
        console.log('---- 诊断 ----');
        for (const d of out.diagnostics) console.log(`[${d.severity}] ${d.code} @${d.offset}: ${d.message}`);
      }
      if (out.status === 'error') process.exitCode = 1;
      return;
    }
    if (args.command === 'list') {
      const limit = Number(args.options.get('limit') ?? '50');
      const records = queryRecords(db, Number.isNaN(limit) ? 50 : limit);
      if (records.length === 0) {
        console.log('（暂无记录）');
        return;
      }
      for (const r of records) {
        console.log(`#${r.id}  ${r.status.padEnd(7)}  ${r.input_bytes} 字节  块=${r.chunk_size}  ${r.created_at}  ${r.name}`);
      }
      return;
    }
    if (args.command === 'show') {
      const id = Number(args.positional[0]);
      if (!Number.isInteger(id)) throw new ValidationError('INVALID_ID', 'show 需要记录 ID');
      const record = queryRecordDetail(db, id);
      if (args.options.has('raw')) {
        process.stdout.write(record.raw);
        if (!record.raw.endsWith('\n')) process.stdout.write('\n');
        return;
      }
      console.log(`#${record.id}  状态: ${record.status}  名称: ${record.name}`);
      if (record.error_message) console.log(`错误: ${record.error_message}`);
      console.log('---- 还原结果 ----');
      console.log(record.result ?? '（失败转换，无结果）');
      return;
    }
    if (args.command === 'diagnostics') {
      const id = Number(args.positional[0]);
      if (!Number.isInteger(id)) throw new ValidationError('INVALID_ID', 'diagnostics 需要记录 ID');
      const diags = queryDiagnostics(db, id);
      if (diags.length === 0) {
        console.log('无诊断信息');
        return;
      }
      for (const d of diags) {
        console.log(`#${d.seq} [${d.severity}] ${d.code} @${d.offset}: ${d.message}${d.raw ? `  原始=${JSON.stringify(d.raw)}` : ''}`);
      }
      return;
    }
    if (args.command === 'export') {
      const id = Number(args.positional[0]);
      if (!Number.isInteger(id)) throw new ValidationError('INVALID_ID', 'export 需要记录 ID');
      const record = queryRecordDetail(db, id);
      if (record.result === null) throw new ValidationError('NO_RESULT', '失败转换没有可导出文本');
      const outFile = args.options.get('out');
      if (outFile) {
        writeFileSync(outFile, record.result, 'utf8');
        console.log(`已导出到 ${outFile}`);
      } else {
        process.stdout.write(record.result);
      }
      return;
    }
    usage();
  } catch (err) {
    if (err instanceof ValidationError) {
      console.error(`错误 [${err.code}]: ${err.message}`);
      process.exit(1);
    }
    throw err;
  }
}

main();
