/**
 * 端到端演示：生成演示日志 -> 不同块大小转换入库 -> 对比覆盖残留与显式擦除
 * -> 展示未支持指令诊断 -> 重新打开数据库验证持久化。
 * 运行: npm run demo
 */
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase } from '../dist/src/db.js';
import { convertAndSave, queryDiagnostics, queryRecordDetail, queryRecords } from '../dist/src/service.js';

const demoDir = mkdtempSync(join(tmpdir(), 'tor-demo-'));
const dbPath = join(demoDir, 'restorer.db');

function header(title: string): void {
  console.log(`\n=== ${title} ===`);
}

function showRaw(label: string, raw: string): void {
  console.log(`-- ${label} 的原始字节表示 --`);
  console.log(JSON.stringify(raw));
}

// 1) 百分比进度更新
const progress = [
  '下载中   0%\r',
  '下载中  25%\r',
  '下载中  75%\r',
  '下载中 100% 完成\n',
].join('');

// 2a) 短覆盖长，不擦除 => 残留
const overwriteNoErase = 'working...\rdone\n';
// 2b) 短覆盖长，先 CSI K 擦到行尾 => 无残留
const overwriteWithErase = 'working...\r\x1b[Kdone\n';

// 3) 带颜色 + 中文 + 不支持的光标移动
const mixed = '\x1b[32m部署中\x1b[0m 0%\r\x1b[32m部署中\x1b[0m 100%\n\x1b[5A一条普通日志\n';

const files: Record<string, string> = {
  'progress.log': progress,
  'no-erase.log': overwriteNoErase,
  'with-erase.log': overwriteWithErase,
  'mixed.log': mixed,
};
for (const [name, content] of Object.entries(files)) {
  writeFileSync(join(demoDir, name), content, 'utf8');
}

header('演示目录');
console.log(demoDir);

header('1. 百分比进度更新（回车覆盖）');
showRaw('progress.log', progress);
{
  const db = openDatabase(dbPath);
  const out = convertAndSave(db, { filePath: join(demoDir, 'progress.log'), name: 'progress.log' });
  console.log('还原结果:');
  console.log(out.result);
  console.log(`状态: ${out.status}`);
  db.close();
}

header('2. 短文本覆盖长文本：残留 vs 显式擦除');
showRaw('no-erase.log', overwriteNoErase);
showRaw('with-erase.log', overwriteWithErase);
{
  const db = openDatabase(dbPath);
  const a = convertAndSave(db, { filePath: join(demoDir, 'no-erase.log'), name: 'no-erase.log' });
  const b = convertAndSave(db, { filePath: join(demoDir, 'with-erase.log'), name: 'with-erase.log' });
  console.log(`无擦除   => ${JSON.stringify(a.result)}（"done" 后残留旧字符）`);
  console.log(`CSI K 擦除 => ${JSON.stringify(b.result)}（行尾已清空，无残留）`);
  db.close();
}

header('3. 颜色忽略 + 未支持指令产生诊断（不静默）');
showRaw('mixed.log', mixed);
{
  const db = openDatabase(dbPath);
  const out = convertAndSave(db, { filePath: join(demoDir, 'mixed.log'), name: 'mixed.log' });
  console.log('还原结果:');
  console.log(out.result);
  console.log(`状态: ${out.status}`);
  for (const d of out.diagnostics) console.log(`  [${d.severity}] ${d.code}: ${d.message}`);
  db.close();
}

header('4. 不同块大小结果一致');
{
  const db = openDatabase(dbPath);
  const results: string[] = [];
  for (const size of [1, 3, 16, 4096]) {
    const out = convertAndSave(db, { filePath: join(demoDir, 'progress.log'), name: `progress@${size}`, chunkSize: size });
    results.push(out.result ?? '');
  }
  console.log(results.every((r) => r === results[0]) ? '块大小 1/3/16/4096 的结果完全一致 ✓' : '结果不一致 ✗');
  db.close();
}

header('5. 重启后仍可查看原文、结果与问题');
{
  const db = openDatabase(dbPath); // 重新打开
  const records = queryRecords(db, 10);
  console.log(`历史记录共 ${records.length} 条（最新在前）:`);
  for (const r of records.slice(0, 5)) console.log(`  #${r.id} ${r.status.padEnd(7)} ${r.name}`);
  const mixedRecord = records.find((r) => r.name === 'mixed.log')!;
  const detail = queryRecordDetail(db, mixedRecord.id);
  console.log(`\n记录 #${detail.id} 原文: ${JSON.stringify(detail.raw)}`);
  console.log(`记录 #${detail.id} 结果: ${JSON.stringify(detail.result)}`);
  const diags = queryDiagnostics(db, mixedRecord.id);
  console.log(`记录 #${detail.id} 诊断: ${diags.map((d) => d.code).join(', ')}`);
  db.close();
}

header('导出纯文本（CLI 等价命令）');
console.log(`node dist/cli/index.js export 1 --out result.txt --data-dir "${demoDir}"`);

console.log('\n演示完成。');
