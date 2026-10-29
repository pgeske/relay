import { expect, test } from "bun:test";
import { configFor } from "./tmux.ts";

test("tmux before 3.4 gets the theme without the underline colour it would reject", () => {
  for (const version of ["tmux 3.2a", "tmux 3.3a"]) {
    const config = configFor(version, true);
    expect(config).not.toContain("us=");
    expect(config).toContain("set -g status-style 'fg=#c6d0f5,bg=#292c3c,none'");
  }
});

test("tmux 3.4 and newer, including development builds, keep the underline colour", () => {
  for (const version of ["tmux 3.4", "tmux 3.7b", "tmux next-3.8", "tmux master", "tmux 4.0"]) {
    expect(configFor(version, true)).toContain("underscore,us=#737994");
  }
});
