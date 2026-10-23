import { randomBytes, timingSafeEqual } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { TOKEN_PATH } from "./paths.ts";

let cachedToken: string | null = null;

/** Reads the bearer token, creating it (32 random bytes, hex, mode 600) on first run. */
export function loadToken(): string {
  if (cachedToken) return cachedToken;

  try {
    const existing = readFileSync(TOKEN_PATH, "utf8").trim();
    if (existing) {
      cachedToken = existing;
      return existing;
    }
  } catch {
    // Missing token file: fall through and create one.
  }

  const token = randomBytes(32).toString("hex");
  mkdirSync(dirname(TOKEN_PATH), { recursive: true, mode: 0o700 });
  writeFileSync(TOKEN_PATH, `${token}\n`, { mode: 0o600 });
  chmodSync(TOKEN_PATH, 0o600);
  cachedToken = token;
  return token;
}

export function tokenMatches(candidate: string): boolean {
  const expected = Buffer.from(loadToken(), "utf8");
  const provided = Buffer.from(candidate, "utf8");
  if (expected.length !== provided.length) return false;
  return timingSafeEqual(expected, provided);
}
