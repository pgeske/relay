import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Tests never touch your relay data (board.db, tmux.conf, uploads): relay's data dir resolves to a scratch one.
const dataHome = mkdtempSync(join(tmpdir(), "relay-test-data-"));
process.env.XDG_DATA_HOME = dataHome;
process.on("exit", () => rmSync(dataHome, { recursive: true, force: true }));
