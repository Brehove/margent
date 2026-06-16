import { describe, expect, it } from "vitest";
import { BaseDirectory } from "@tauri-apps/plugin-fs";
import { getParentDirectoryPath, getScopedWatchTarget } from "./watchTarget";

describe("watchTarget", () => {
  it("maps home-relative paths to BaseDirectory.Home", () => {
    expect(
      getScopedWatchTarget("/Users/example/Documents/project/file.md", {
        delayMs: 250,
      }),
    ).toEqual({
      path: "Documents/project/file.md",
      options: {
        baseDir: BaseDirectory.Home,
        delayMs: 250,
      },
    });
  });

  it("leaves non-home absolute paths unchanged", () => {
    expect(
      getScopedWatchTarget("/tmp/margent-watch-test/test.md", {
        recursive: true,
      }),
    ).toEqual({
      path: "/tmp/margent-watch-test/test.md",
      options: {
        recursive: true,
      },
    });
  });

  it("returns the containing directory for a file path", () => {
    expect(
      getParentDirectoryPath("/Users/example/Documents/project/file.md"),
    ).toBe("/Users/example/Documents/project");
  });
});
