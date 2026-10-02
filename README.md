# term-log-reducer

本地终端输出整理服务：把包含进度覆盖（`\r`）和少量 ANSI 转义序列的 UTF-8 原始日志，还原成可阅读的纯文本。仅提供 HTTP API 与 CLI，不启动真实命令、不连接终端、不做全屏终端模拟。纯 TypeScript + Node.js + SQLite（`node:sqlite`，零运行时依赖），Windows 本地直接运行。

## 环境要求

- Node.js ≥ 22.5（使用内置 `node:sqlite`；开发环境为 Node 25）
- 不需要 Docker / WSL / 任何外部服务

## 快速开始

```powershell
npm install        # 仅安装 typescript / @types/node（开发依赖）
npm run build      # 编译到 dist/
npm test           # 构建并运行全部自动化测试
npm run demo       # 内置演示：进度覆盖、残留 vs 擦除、退格、未支持指令诊断
npm start          # 启动 HTTP API（默认自动选择空闲端口并打印）
```

数据保存在项目内 `data/` 目录（`data/conversions.db`），可用环境变量 `DATA_DIR` 覆盖。端口用 `--port N` 或环境变量 `PORT` 指定，缺省为 `0`（自动选空闲端口）。

## 支持列表

| 输入 | 行为 |
| --- | --- |
| 普通字符 | 写入当前光标位置，覆盖该处已有字符 |
| `\r` | 光标回到当前行行首（不删除任何字符） |
| `\n` / `\r\n` | 提交当前行，进入下一行行首 |
| `\b` | 光标左移一格，**不**自动删除字符 |
| `ESC [ ... m`（SGR 颜色） | 识别并忽略 |
| `ESC [ K` / `ESC [ 0 K` | 擦除光标到行尾 |
| `ESC [ 1 K` | 擦除行首到光标（以空格填充） |
| `ESC [ 2 K` | 擦除整行 |
| 其他 CSI / ESC 序列（如光标移动 `A/B/C/D/H`、`2J`） | 忽略并产生 `UNSUPPORTED_ESCAPE` 诊断 |
| 其他 C0 控制字符 | 忽略并产生 `UNSUPPORTED_CONTROL` 诊断 |
| 输入末尾未结束的转义序列 | 产生 `UNTERMINATED_ESCAPE` 诊断 |

**已知限制**：位置按 Unicode 码点计算，不模拟中日韩宽字符、组合字符、Emoji 的真实终端列宽；含这类字符的覆盖对齐可能与真实终端显示不同。只处理逐行输出，不支持全屏光标定位。

**诊断即失败**：只要产生任何诊断，记录状态即为 `failed`，不会静默声称已完整还原；原文、结果与诊断一起存入 SQLite，重启后仍可查看。

## CLI 用法

```powershell
node dist/src/cli.js serve --port 8080        # 启动 API（缺省自动选空闲端口）
node dist/src/cli.js convert app.log --name 构建日志 --chunk-size 4096
node dist/src/cli.js list                     # 历史记录
node dist/src/cli.js show 1                   # 元信息；--raw 原文 / --result 结果 / --diag 诊断
node dist/src/cli.js export 1 -o out.txt      # 导出纯文本（缺省输出到 stdout）
node dist/src/cli.js demo
```

`--chunk-size` 为读取文件的字节块大小；UTF-8 解码使用 `StringDecoder`，跨块的多字节字符（如中文）不会被拆坏，同一输入任意块大小结果一致（有测试保证）。

## HTTP API

统一错误格式：`{"error": {"code": "...", "message": "..."}}`，错误码 `INVALID_ARGUMENT`(400)、`NOT_FOUND`(404)、`INTERNAL`(500)。

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/api/conversions` | 一次性转换：`{"name?", "content"}` 或 `{"name?", "filePath", "chunkSize?"}` |
| POST | `/api/sessions` | 开启分块会话，返回 `sessionId` |
| POST | `/api/sessions/:id/chunks` | 追加块：`{"data": "<base64>"}`（字节级，UTF-8 安全） |
| POST | `/api/sessions/:id/finalize` | 结束会话并保存：`{"name?"}` |
| GET | `/api/conversions` | 历史记录列表 |
| GET | `/api/conversions/:id` | 完整记录（含原文、结果、诊断） |
| GET | `/api/conversions/:id/raw` | 原始内容（text/plain） |
| GET | `/api/conversions/:id/result` | 还原结果（text/plain） |
| GET | `/api/conversions/:id/diagnostics` | 诊断列表（JSON） |
| GET | `/api/conversions/:id/export` | 导出纯文本（attachment） |

示例：

```powershell
# 启动后替换为实际端口
curl -X POST http://127.0.0.1:8080/api/conversions -H "content-type: application/json" -d '{"name":"demo","content":"abcdef\rxy\x1b[K\n"}'
curl http://127.0.0.1:8080/api/conversions/1/result
```

## 复现命令

```powershell
npm install; npm run build; npm test; npm run demo
```

## 项目结构

- `src/reducer.ts` — 核心还原器（按码点流式处理，转义序列跨块缓冲）
- `src/convert.ts` — 文件分块读取（`StringDecoder`）与分块会话
- `src/store.ts` — SQLite 持久化（原文 / 结果 / 诊断 / 状态）
- `src/server.ts` — HTTP API
- `src/cli.ts` — 命令行入口
- `src/demo.ts` — 演示
- `tests/` — node:test 自动化测试（19 个用例）
