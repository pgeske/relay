import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import skill from "./skill/SKILL.md" with { type: "text" };

/** omp loads skills from here; relay owns the "relay" folder in it. */
const SKILL_PATH = join(homedir(), ".omp", "agent", "skills", "relay", "SKILL.md");

/** Installs the skill that teaches omp agents to use relay, when it differs from the copy on disk. */
export function installSkill(): void {
  if (existsSync(SKILL_PATH) && readFileSync(SKILL_PATH, "utf8") === skill) return;
  mkdirSync(dirname(SKILL_PATH), { recursive: true });
  writeFileSync(SKILL_PATH, skill);
}
