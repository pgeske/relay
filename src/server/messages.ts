import { open, readFile } from "node:fs/promises";
import { join } from "node:path";
import { BLOBS_DIR } from "./sessionFile.ts";
import { summarizeToolCall } from "./toolSummary.ts";

export type TextBlock = { type: "text"; text: string };
export type ThinkingBlock = { type: "thinking"; text: string };
export type ToolCallBlock = {
  type: "toolCall";
  id: string;
  name: string;
  summary: string;
  argsJson: string;
};
export type ToolResultBlock = {
  type: "toolResult";
  toolCallId: string;
  name: string;
  text: string;
  truncated: boolean;
  isError: boolean;
};
export type ImageBlock = { type: "image"; url: string };
export type Block = TextBlock | ThinkingBlock | ToolCallBlock | ToolResultBlock | ImageBlock;

export type Message = {
  id: string;
  role: "user" | "assistant" | "tool";
  timestamp: string;
  blocks: Block[];
};

/** Tool output and pretty-printed arguments are capped; the app never needs the whole blob. */
const MAX_BLOCK_TEXT = 4000;
const MAX_ARGS_JSON = 4000;
/** Backwards paging reads 256 KiB chunks so huge sessions stay cheap to page. */
const READ_CHUNK_BYTES = 256 * 1024;

type RawImage = { data: string; mimeType?: string };

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

/** Parses one jsonl line; null for blank lines, partial writes, and JSON that is not an object. */
export function parseJsonEntry(line: string): Record<string, unknown> | null {
  if (!line.trim()) return null;
  try {
    return asRecord(JSON.parse(line));
  } catch {
    return null;
  }
}

function imageUrl(paneId: string, entryId: string, index: number): string {
  return `/api/sessions/${encodeURIComponent(paneId)}/images/${encodeURIComponent(entryId)}/${index}`;
}

function entryTimestamp(entry: Record<string, unknown>): string {
  if (typeof entry.timestamp === "string") return entry.timestamp;
  if (typeof entry.timestamp === "number") return new Date(entry.timestamp).toISOString();
  const message = asRecord(entry.message);
  if (message && typeof message.timestamp === "number") {
    return new Date(message.timestamp).toISOString();
  }
  return new Date(0).toISOString();
}

/** Image blocks of a message entry, in content order (used for both URLs and byte lookup). */
function rawImagesOf(entry: Record<string, unknown>): RawImage[] {
  const message = asRecord(entry.message);
  if (!message || !Array.isArray(message.content)) return [];
  const images: RawImage[] = [];
  for (const part of message.content) {
    const block = asRecord(part);
    if (block?.type !== "image" || typeof block.data !== "string") continue;
    images.push({
      data: block.data,
      mimeType: typeof block.mimeType === "string" ? block.mimeType : undefined,
    });
  }
  return images;
}

function toolCallArgsJson(args: unknown): string {
  if (args === undefined) return "";
  try {
    return JSON.stringify(args, null, 2).slice(0, MAX_ARGS_JSON);
  } catch {
    return "";
  }
}

/** Converts one jsonl entry into a Message, or null for non-chat entries. */
export function normalizeEntry(entry: Record<string, unknown>, paneId: string): Message | null {
  const message = asRecord(entry.message);
  if (!message) return null;
  const id = typeof entry.id === "string" ? entry.id : "";
  if (!id) return null;

  const role = message.role;
  if (role !== "user" && role !== "assistant" && role !== "toolResult") return null;

  const timestamp = entryTimestamp(entry);
  const content = message.content;
  const blocks: Block[] = [];
  let imageIndex = 0;

  if (role === "user") {
    if (typeof content === "string") {
      if (content.trim()) blocks.push({ type: "text", text: content });
    } else if (Array.isArray(content)) {
      for (const part of content) {
        const block = asRecord(part);
        if (!block) continue;
        if (block.type === "text" && typeof block.text === "string" && block.text.trim()) {
          blocks.push({ type: "text", text: block.text });
        } else if (block.type === "image") {
          blocks.push({ type: "image", url: imageUrl(paneId, id, imageIndex) });
          imageIndex += 1;
        }
      }
    }
    if (blocks.length === 0) return null;
    return { id, role: "user", timestamp, blocks };
  }

  if (role === "assistant") {
    if (typeof content === "string") {
      if (content.trim()) blocks.push({ type: "text", text: content });
    } else if (Array.isArray(content)) {
      for (const part of content) {
        const block = asRecord(part);
        if (!block) continue;
        if (block.type === "text" && typeof block.text === "string" && block.text.trim()) {
          blocks.push({ type: "text", text: block.text });
        } else if (block.type === "thinking" && typeof block.thinking === "string") {
          blocks.push({ type: "thinking", text: block.thinking });
        } else if (block.type === "toolCall") {
          const name = typeof block.name === "string" ? block.name : "tool";
          blocks.push({
            type: "toolCall",
            id: typeof block.id === "string" ? block.id : "",
            name,
            summary: summarizeToolCall(name, block.arguments),
            argsJson: toolCallArgsJson(block.arguments),
          });
        } else if (block.type === "image") {
          blocks.push({ type: "image", url: imageUrl(paneId, id, imageIndex) });
          imageIndex += 1;
        }
      }
    }
    if (blocks.length === 0) return null;
    return { id, role: "assistant", timestamp, blocks };
  }

  // role === "toolResult": text becomes one block, images follow it.
  const texts: string[] = [];
  if (typeof content === "string") {
    texts.push(content);
  } else if (Array.isArray(content)) {
    for (const part of content) {
      const block = asRecord(part);
      if (!block) continue;
      if (block.type === "text" && typeof block.text === "string") texts.push(block.text);
      else if (block.type === "image") {
        blocks.push({ type: "image", url: imageUrl(paneId, id, imageIndex) });
        imageIndex += 1;
      }
    }
  }

  const fullText = texts.join("\n");
  const toolResult: ToolResultBlock = {
    type: "toolResult",
    toolCallId: typeof message.toolCallId === "string" ? message.toolCallId : "",
    name: typeof message.toolName === "string" ? message.toolName : "tool",
    text: fullText.slice(0, MAX_BLOCK_TEXT),
    truncated: fullText.length > MAX_BLOCK_TEXT,
    isError: message.isError === true,
  };
  return { id, role: "tool", timestamp, blocks: [toolResult, ...blocks] };
}

/**
 * Walks a jsonl file newest line first, in fixed-size byte chunks, so paging never loads the
 * whole (potentially hundreds of MB) file. `visit` returns false to stop early.
 */
export async function scanLinesBackwards(
  filePath: string,
  visit: (line: string) => boolean,
): Promise<void> {
  const file = await open(filePath, "r");
  let carryBytes = Buffer.alloc(0);
  try {
    let position = (await file.stat()).size;
    while (position > 0) {
      const start = Math.max(0, position - READ_CHUNK_BYTES);
      const buffer = Buffer.allocUnsafe(position - start);
      await file.read(buffer, 0, buffer.length, start);
      // Old bytes first, then the fragment carried over from the chunk to the right.
      const combined = Buffer.concat([buffer, carryBytes]);
      const firstNewline = combined.indexOf(0x0a);
      if (firstNewline === -1) {
        // One line longer than the chunk: keep accumulating it.
        carryBytes = combined;
        position = start;
        continue;
      }
      carryBytes = Buffer.from(combined.subarray(0, firstNewline));
      const lines = combined.subarray(firstNewline + 1).toString("utf8").split("\n");
      for (let index = lines.length - 1; index >= 0; index -= 1) {
        const line = lines[index].trim();
        if (!line) continue;
        if (!visit(line)) return;
      }
      position = start;
    }
  } finally {
    await file.close();
  }
}

export type MessagePage = { messages: Message[]; hasMore: boolean; beforeFound: boolean };

/** Reads up to `limit` messages ending just before `before` (or at the end of the file). */
export async function readMessagePage(
  filePath: string,
  paneId: string,
  options: { before?: string; limit: number },
): Promise<MessagePage> {
  const newestFirst: Message[] = [];
  let beforeFound = options.before === undefined;
  let hasMore = false;

  await scanLinesBackwards(filePath, (line) => {
    const entry = parseJsonEntry(line);
    if (!entry || entry.type !== "message") return true;
    const id = typeof entry.id === "string" ? entry.id : "";
    if (!beforeFound) {
      if (id === options.before) beforeFound = true;
      return true;
    }
    if (newestFirst.length >= options.limit) {
      hasMore = true;
      return false;
    }
    const message = normalizeEntry(entry, paneId);
    if (message) newestFirst.push(message);
    return true;
  });

  return { messages: newestFirst.reverse(), hasMore, beforeFound };
}

const IMAGE_EXTENSIONS: Record<string, string[]> = {
  "image/png": ["png"],
  "image/jpeg": ["jpg", "jpeg"],
  "image/gif": ["gif"],
  "image/webp": ["webp"],
};

function sniffContentType(bytes: Buffer): string {
  if (bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "image/png";
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  const header = bytes.subarray(0, 6).toString("ascii");
  if (header === "GIF87a" || header === "GIF89a") return "image/gif";
  if (bytes.subarray(0, 4).toString("ascii") === "RIFF" && bytes.subarray(8, 12).toString("ascii") === "WEBP") return "image/webp";
  return "application/octet-stream";
}

async function loadImage(image: RawImage): Promise<{ bytes: Buffer; contentType: string } | null> {
  const blobMatch = /^blob:sha256:([0-9a-f]{64})$/i.exec(image.data);
  if (blobMatch) {
    const hash = blobMatch[1].toLowerCase();
    const extensions = IMAGE_EXTENSIONS[image.mimeType ?? ""] ?? ["png", "jpg", "jpeg", "webp", "gif"];
    for (const name of [hash, ...extensions.map((extension) => `${hash}.${extension}`)]) {
      try {
        const bytes = await readFile(join(BLOBS_DIR, name));
        return { bytes, contentType: image.mimeType ?? sniffContentType(bytes) };
      } catch {
        // omp hard-links blobs both with and without an extension; try the next name.
      }
    }
    return null;
  }

  const base64 = image.data.replace(/^data:[^,]*,/, "");
  const bytes = Buffer.from(base64, "base64");
  if (bytes.length === 0) return null;
  return { bytes, contentType: image.mimeType ?? sniffContentType(bytes) };
}

/** Reads the nth image of one entry, whether stored inline (base64) or as an omp blob. */
export async function readEntryImage(
  filePath: string,
  entryId: string,
  index: number,
): Promise<{ bytes: Buffer; contentType: string } | null> {
  let match: Record<string, unknown> | null = null;
  await scanLinesBackwards(filePath, (line) => {
    const entry = parseJsonEntry(line);
    if (!entry) return true;
    if (entry.id === entryId) {
      match = entry;
      return false;
    }
    return true;
  });
  if (!match) return null;
  const image = rawImagesOf(match)[index];
  if (!image) return null;
  return loadImage(image);
}
