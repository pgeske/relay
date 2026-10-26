import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { VOICE_ENABLED_PATH } from "./paths.ts";

/**
 * Live voice calls reroute the Mac's audio through BlackHole loopback devices, so they
 * stay off until someone runs `relay voice on`. The setting is the presence of a marker
 * file, read on every check, so turning it on or off needs no server restart.
 */
export function isVoiceEnabled(): boolean {
  return existsSync(VOICE_ENABLED_PATH);
}

export function setVoiceEnabled(enabled: boolean): void {
  if (enabled) {
    mkdirSync(dirname(VOICE_ENABLED_PATH), { recursive: true });
    writeFileSync(VOICE_ENABLED_PATH, "");
  } else {
    rmSync(VOICE_ENABLED_PATH, { force: true });
  }
}
