import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { CONFIG_DIR } from "../paths.ts";

export const BOARD_CONFIG_PATH = join(CONFIG_DIR, "board.json");

/** Where the board reads pull requests from. */
export interface BoardSource {
  /** GitHub organization to search; omitted means every repository the account can see. */
  org?: string;
  /** `gh` account whose token to use (`gh auth token --user`); omitted means gh's active account. */
  ghUser?: string;
}

export interface BoardConfig {
  sources: BoardSource[];
  /**
   * Checks that gate merging rather than test the code (a merge queue's own check, say).
   * They are ignored while running, so they never make CI look busy, and block when they fail.
   */
  gateChecks: string[];
  /** How many days back the Merged section reaches. */
  mergedDays: number;
  /**
   * Teams ("org/team") whose review requests count as waiting on you, besides requests made of
   * you by name. Empty means every team you are on, which can include busy admin teams.
   */
  reviewTeams: string[];
  /** Relay's watcher, which reads a session when its agent stops (or goes quiet) and fixes the task's card if the agent didn't. */
  autoStatus: {
    enabled: boolean;
    /** The omp model it asks: a `provider/id` (with an optional `:level`) or a role alias. Default: omp's fast `@smol` role. */
    model: string;
  };
}

const DEFAULTS: BoardConfig = { sources: [{}], gateChecks: [], mergedDays: 7, reviewTeams: [], autoStatus: { enabled: true, model: "@smol" } };

/** Reads ~/.config/relay/board.json; every field is optional. */
export function loadBoardConfig(): BoardConfig {
  if (!existsSync(BOARD_CONFIG_PATH)) return DEFAULTS;
  const raw = JSON.parse(readFileSync(BOARD_CONFIG_PATH, "utf8")) as Partial<Omit<BoardConfig, "autoStatus">> & { autoStatus?: Partial<BoardConfig["autoStatus"]> };
  return {
    sources: raw.sources?.length ? raw.sources : DEFAULTS.sources,
    gateChecks: raw.gateChecks ?? DEFAULTS.gateChecks,
    mergedDays: raw.mergedDays ?? DEFAULTS.mergedDays,
    reviewTeams: raw.reviewTeams ?? DEFAULTS.reviewTeams,
    autoStatus: { ...DEFAULTS.autoStatus, ...raw.autoStatus },
  };
}
