import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Tests never touch your relay data (board.db, tmux.conf, uploads) or config (the server's token):
// relay's data and config dirs resolve to scratch ones.
const dataHome = mkdtempSync(join(tmpdir(), "relay-test-data-"));
const configHome = mkdtempSync(join(tmpdir(), "relay-test-config-"));
process.env.XDG_DATA_HOME = dataHome;
process.env.XDG_CONFIG_HOME = configHome;
process.on("exit", () => {
  rmSync(dataHome, { recursive: true, force: true });
  rmSync(configHome, { recursive: true, force: true });
});
