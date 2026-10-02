# 终端输出回车覆盖与 ANSI 文本还原后端

把包含**进度条回车覆盖**和**少量 ANSI 转义序列**的 UTF-8 原始日志，还原成可阅读的纯文本。
只做普通命令行逐行输出的还原，**不启动真实命令、不连接终端、不是日志搜索平台、不是全屏终端模拟器**。

- 语言/运行时：TypeScript + Node.js（建议 Node ≥ 22.5，开发环境实测 Node v25.5）
- 存储：SQLite（内置 `node:sqlite`，零原生编译、零运行时第三方依赖）
- 形态：本地 HTTP API + CLI，仅监听 `127.0.0.1`
- 无需 Docker、WSL、付费服务或在线 API

## 支持与不支持

### 支持的行为

| 输入 | 处理 |
| --- | --- |
| 普通可打印字符（含中文等 UTF-8 内容） | 写入当前光标位置 |
| `\r`（CR） | 回到当前行首，**不提交行**；后续字符逐位覆盖旧字符 |
| `\n`（LF）、`\r\n`（CRLF） | 提交当前行；CRLF 只算一次换行 |
| `\b`（BS） | 光标左移一格，**不自动删除字符**；之后写入才会覆盖 |
| `\t`（TAB） | 跳到下一个 8 列制表位（补空格） |
| `ESC[...m`（SGR 颜色/样式） | 识别并忽略（含被拆在多个输入块中的序列） |
| `ESC[K` / `ESC[0K` | 擦除光标到行尾 |
| `ESC[1K` | 擦除行首到光标（含光标位置） |
| `ESC[2K` | 擦除整行 |

### 会产生诊断、不会静默处理的情况

| 代码 | 含义 | 记录状态 |
| --- | --- | --- |
| `UNSUPPORTED_CSI` | 不支持的 CSI 指令（如 `ESC[5A` 光标上移） | `warning` |
| `UNSUPPORTED_ESCAPE` | 不支持的 ESC/OSC 序列（如 `ESC]0;标题 BEL`） | `warning` |
| `UNKNOWN_SGR` / `UNKNOWN_ERASE_MODE` | 参数无法识别 | `warning` |
| `INCOMPLETE_ESCAPE` | 文件结束时序列未结束（如末尾只有 `ESC[31`） | `warning` |
| `UNSUPPORTED_CONTROL` | 其它不支持的 C0 控制字符 | `warning` |
| `INVALID_UTF8` | 非法或末尾不完整的 UTF-8 字节 | `error`（不保存结果文本，不会被记成成功） |

### 明确的范围限制

- 位置按 **Unicode 码点**计算，**不模拟**中日韩宽字符、组合字符（如 `e\u0301`）、emoji
  的真实终端列宽。因此这类字符与退格/覆盖/制表位组合时，列位置可能与真实终端有差异。
- 不模拟光标行列移动、滚屏、备用屏幕、终端标题等全屏 TUI 行为；相关序列只给诊断。
- 不做海量实时采集；单次请求/文件上限 20 MiB（`src/service.ts` 中可调）。

## 快速开始

```powershell
npm install
npm run build
npm test        # 构建 + 33 个自动化测试
npm run demo    # 端到端演示（进度条 / 残留 vs 擦除 / 诊断 / 重启持久化）
```

## CLI 使用

数据目录默认 `./data`，可用 `--data-dir` 或环境变量 `TOR_DATA_DIR` 覆盖。

```powershell
# 转换项目内日志（chunk-size 可调，默认 4096，不同块大小结果一致）
node --experimental-sqlite dist/src/cli/index.js convert --file samples/progress.log --chunk-size 3

# 历史记录
node --experimental-sqlite dist/src/cli/index.js list

# 查看某条记录（默认结果；--raw 查看未改动的原文）
node --experimental-sqlite dist/src/cli/index.js show 1
node --experimental-sqlite dist/src/cli/index.js show 1 --raw

# 查询诊断
node --experimental-sqlite dist/src/cli/index.js diagnostics 1

# 导出纯文本（stdout 或 --out 文件）
node --experimental-sqlite dist/src/cli/index.js export 1 --out result.txt
```

CLI 错误码：`MISSING_FILE`、`INVALID_ID`、`NOT_FOUND`、`NO_RESULT`、
`INVALID_CHUNK_SIZE`、`MISSING_SOURCE`、`FILE_READ_FAILED`、`INPUT_TOO_LARGE`。
失败转换时 `convert` 退出码为 1。

## HTTP API

启动服务（默认端口 `0` = 自动选择空闲端口；也可显式指定）：

```powershell
npm start                                    # 自动空闲端口，数据目录 ./data
node --experimental-sqlite dist/src/cli/server.js --port 8787 --data-dir data
```

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| `POST` | `/api/convert` | 一次性转换（JSON） |
| `POST` | `/api/chunk-sessions` | 创建分块输入会话 |
| `POST` | `/api/chunk-sessions/{id}/chunks` | 追加一个 Base64 字节块 |
| `POST` | `/api/chunk-sessions/{id}/finish` | 结束会话并转换入库 |
| `GET` | `/api/records?limit=50` | 历史记录（最新在前） |
| `GET` | `/api/records/{id}` | 原文 + 结果 + 元数据 |
| `GET` | `/api/records/{id}/diagnostics` | 诊断列表 |
| `GET` | `/api/records/{id}/export` | 导出 `text/plain; charset=utf-8` |
| `GET` | `/health` | 健康检查 |

`POST /api/convert` 请求体：

```json
{
  "name": "build.log",
  "content": "进度 0%\r进度 100% 完成\n",
  "chunkSize": 4096
}
```

也可以用 `"filePath": "samples/progress.log"` 读取本地文件（`content` 与 `filePath` 二选一）。
`chunkSize` 为保存前按字节重新切分的大小，整数 1–1048576，默认 4096。

分块上传示例（PowerShell，1 字节一块，跨块中文不会解坏）：

```powershell
$bytes = [Text.Encoding]::UTF8.GetBytes((Get-Content -Raw samples/progress.log))
$s = Invoke-RestMethod "$base/api/chunk-sessions" -Method Post `
  -Body (@{ name = "p.log"; chunkSize = 4096 } | ConvertTo-Json) -ContentType application/json
foreach ($b in $bytes) {
  $b64 = [Convert]::ToBase64String(@($b))
  Invoke-RestMethod "$base/api/chunk-sessions/$($s.sessionId)/chunks" -Method Post `
    -Body (@{ chunk = $b64 } | ConvertTo-Json) -ContentType application/json | Out-Null
}
Invoke-RestMethod "$base/api/chunk-sessions/$($s.sessionId)/finish" -Method Post
```

HTTP 错误响应统一形如 `{"error":{"code":"...","message":"..."}}`：
参数/请求体问题返回 400（`INVALID_BODY`、`INVALID_JSON`、`INVALID_NAME`、`INVALID_CONTENT`、
`MISSING_SOURCE`、`INVALID_CHUNK_SIZE`、`INVALID_FILE_PATH`、`FILE_READ_FAILED`、
`INPUT_TOO_LARGE`、`BODY_TOO_LARGE`、`SESSION_NOT_FOUND`、`INVALID_CHUNK`、`INVALID_LIMIT`），
记录不存在返回 404（`NOT_FOUND`、路由未命中、失败记录导出 `NO_RESULT`），其余为 500 `INTERNAL`。

## 数据库

SQLite 文件位于 `<数据目录>/restorer.db`（WAL 模式）。两张表：

- `records`：`id, name, status(ok|warning|error), chunk_size, input_bytes, created_at,
  error_message, raw(原文，永不修改), result(还原文本，失败为 NULL)`
- `diagnostics`：`record_id, seq, code, severity, message, offset, raw`

关闭进程后重新打开数据库（或重启服务/CLI），原文、结果与诊断都仍可查看，已有测试覆盖该场景。

## 项目结构

```
src/parser.ts        核心：UTF-8 增量解码 + 行还原状态机
src/db.ts            SQLite 建表与查询
src/service.ts       转换、校验、分块会话
src/cli/server.ts    HTTP API 服务（默认空闲端口）
src/cli/index.ts     CLI 入口
test/                node:test 自动化测试（33 个用例）
scripts/demo.ts      端到端演示
samples/             示例日志
```

## 关键不变量与复现命令

同一内容无论按 1 字节还是 4096 字节切块，还原结果必须完全一致：

```powershell
npm test
```

测试覆盖：CRLF、回车覆盖（进度更新）、退格后写入、三种 CSI K 行擦除、
SGR 颜色忽略、**跨块转义序列**、**跨块中文（1/2/3 字节切块）**、
文件末尾半截转义、不支持的光标移动/OSC 诊断、非法 UTF-8 记为 `error`、
以及关闭重开数据库后原文/结果/诊断仍在。
