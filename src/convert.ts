import { createReadStream } from "node:fs";
import { StringDecoder } from "node:string_decoder";
import { Reducer, type ReduceResult } from "./reducer.js";

export const DEFAULT_CHUNK_SIZE = 64 * 1024;

/**
 * 按字节分块读取 UTF-8 文件并还原。
 * StringDecoder 保证跨块的多字节字符（如中文）不会被拆坏。
 */
export async function reduceFile(filePath: string, chunkSize = DEFAULT_CHUNK_SIZE): Promise<ReduceResult & { raw: string }> {
  if (!Number.isInteger(chunkSize) || chunkSize < 1) {
    throw Object.assign(new Error("chunkSize 必须是正整数"), { code: "INVALID_ARGUMENT" });
  }
  const decoder = new StringDecoder("utf8");
  const reducer = new Reducer();
  let raw = "";
  const stream = createReadStream(filePath, { highWaterMark: chunkSize });
  for await (const buf of stream) {
    const s = decoder.write(buf as Buffer);
    raw += s;
    reducer.feed(s);
  }
  const tail = decoder.end();
  raw += tail;
  reducer.feed(tail);
  const { text, diagnostics } = reducer.finalize();
  return { text, diagnostics, raw };
}

/** 分块会话：用于 API 的分块输入 */
export class ChunkSession {
  private decoder = new StringDecoder("utf8");
  private reducer = new Reducer();
  private raw = "";

  /** data 为 base64 编码的字节块（保证跨块 UTF-8 安全） */
  feedBase64(data: string): void {
    const buf = Buffer.from(data, "base64");
    const s = this.decoder.write(buf);
    this.raw += s;
    this.reducer.feed(s);
  }

  finalize(): ReduceResult & { raw: string } {
    const tail = this.decoder.end();
    this.raw += tail;
    this.reducer.feed(tail);
    const { text, diagnostics } = this.reducer.finalize();
    return { text, diagnostics, raw: this.raw };
  }
}
