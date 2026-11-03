import { expect, test } from "bun:test";
import { expectedChecksum, isNewerVersion } from "./update.ts";

test("compares versions numerically, not as text", () => {
  expect(isNewerVersion("0.10.0", "0.9.3")).toBe(true);
  expect(isNewerVersion("0.9.3", "0.10.0")).toBe(false);
  expect(isNewerVersion("1.0.0", "0.99.99")).toBe(true);
});

test("an equal version is not an update, with or without a v prefix", () => {
  expect(isNewerVersion("v0.2.0", "0.2.0")).toBe(false);
  expect(isNewerVersion("0.2.1", "v0.2.0")).toBe(true);
});

test("a release's checksums name each asset, and a release without the board app has none for it", () => {
  const checksums = "aaa  relay-darwin-arm64\nbbb  relay-board-macos.zip\n";
  expect(expectedChecksum(checksums, "relay-darwin-arm64")).toBe("aaa");
  expect(expectedChecksum(checksums, "relay-board-macos.zip")).toBe("bbb");
  expect(expectedChecksum("aaa  relay-darwin-arm64\n", "relay-board-macos.zip")).toBeUndefined();
});
