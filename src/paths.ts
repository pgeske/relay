import { homedir } from "node:os";
import { join } from "node:path";

/** Where relay keeps the generated tmux config and phone uploads. */
export const DATA_DIR = join(process.env.XDG_DATA_HOME || join(homedir(), ".local", "share"), "relay");
/** Where relay keeps the phone server's auth token. */
export const CONFIG_DIR = join(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), "relay");
export const CACHE_DIR = join(process.env.XDG_CACHE_HOME || join(homedir(), ".cache"), "relay");

export const TMUX_CONF_PATH = join(DATA_DIR, "tmux.conf");
export const UPLOADS_DIR = join(DATA_DIR, "uploads");
/** The Mac's audio devices from before a live call, kept until the call puts them back. */
export const LIVE_AUDIO_BACKUP_PATH = join(DATA_DIR, "live-audio-defaults.json");
export const TOKEN_PATH = join(CONFIG_DIR, "token");
/** Present when live voice calls are turned on with `relay voice on`. */
export const VOICE_ENABLED_PATH = join(CONFIG_DIR, "voice-enabled");
export const UPDATE_CACHE_PATH = join(CACHE_DIR, "latest-release.json");

export const GITHUB_REPO = "pgeske/relay";
export const SERVER_PORT = Number(process.env.RELAY_PORT ?? 7878);
