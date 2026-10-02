import { reduceText } from "./reducer.js";
import path from "node:path";

function show(title: string, raw: string) {
  const { text, diagnostics } = reduceText([raw]);
  console.log(`\n=== ${title} ===`);
  console.log("原始输入:", JSON.stringify(raw));
  console.log("还原结果:", JSON.stringify(text));
  if (diagnostics.length) {
    console.log("诊断:");
    for (const d of diagnostics) console.log(`  [${d.code}] offset=${d.offset} ${d.message}`);
  }
}

export async function runDemo() {
  show("百分比进度 → 最终完成行",
    "下载中... 10%\r下载中... 45%\r下载中... 99%\r\x1b[32m下载完成 ✓\x1b[0m\x1b[K\n");

  show("短文本覆盖长文本：残留字符（无擦除）",
    "abcdef\rxy\n");

  show("短文本覆盖长文本：显式擦除（CSI K）",
    "abcdef\r\x1b[Kxy\n");

  show("退格后重写",
    "hellp\b\bo world\n");

  show("混入未支持指令（产生诊断，状态记为 failed）",
    "line1\n\x1b[2Jline2\n");
}

if (process.argv[1] && import.meta.url.endsWith(path.basename(process.argv[1]).replace(/\\/g, "/"))) {
  await runDemo();
}
