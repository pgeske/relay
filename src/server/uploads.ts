import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { UPLOADS_DIR } from "../paths.ts";

const UPLOAD_EXTENSIONS: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
};

/** An image a client sent along with its text: from the phone's composer, or pasted into a new task. */
export interface UploadedImage {
  bytes: Buffer;
  mimeType: string;
}

/** Checks a request's `images`: `[{ base64, mimeType }]`, mimeType defaulting to PNG. Absent means none. */
export function parseUploadedImages(raw: unknown): UploadedImage[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) throw new Error("images must be a list");
  return raw.map((image) => {
    if (!image || typeof image !== "object") throw new Error("invalid image");
    const record = image as Record<string, unknown>;
    const bytes = typeof record.base64 === "string" ? Buffer.from(record.base64, "base64") : Buffer.alloc(0);
    if (bytes.length === 0) throw new Error("invalid image");
    return { bytes, mimeType: typeof record.mimeType === "string" ? record.mimeType : "image/png" };
  });
}

/**
 * Saves images where agents can read them, returning one "[Attached image: <path>]" line each:
 * the line the agent reads, and the phone matches its sent messages on.
 */
export async function saveUploadedImages(images: UploadedImage[]): Promise<string[]> {
  if (images.length === 0) return [];
  await mkdir(UPLOADS_DIR, { recursive: true });
  const timestamp = Date.now();
  return Promise.all(
    images.map(async (image, index) => {
      const path = join(UPLOADS_DIR, `${timestamp}-${index}.${UPLOAD_EXTENSIONS[image.mimeType] ?? "bin"}`);
      await writeFile(path, image.bytes);
      return `[Attached image: ${path}]`;
    }),
  );
}
