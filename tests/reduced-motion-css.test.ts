import { describe, expect, it } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";

const SRC_DIR = join(__dirname, "..", "src");

describe("reduced-motion CSS contract", () => {
  it("zeroes motion tokens and disables provider shimmer and pulse animations", () => {
    const tokensCss = readFileSync(join(SRC_DIR, "tokens.css"), "utf8");
    const appCss = readFileSync(join(SRC_DIR, "App.css"), "utf8");
    const reducedTokenBlock = extractMediaBlock(tokensCss, "prefers-reduced-motion: reduce");
    const reducedAppBlock = extractMediaBlock(appCss, "prefers-reduced-motion: reduce");

    [
      "--dur-hover",
      "--dur-state",
      "--dur-panel",
      "--dur-overlay",
      "--dur-rest",
      "--dur-quick",
      "--dur-normal",
      "--dur-slow",
    ].forEach((token) => {
      expect(reducedTokenBlock).toContain(`${token}: 0ms`);
    });

    expect(reducedAppBlock).toContain(".agent-running-line");
    expect(reducedAppBlock).toContain(".topbar-agent-dot");
    expect(reducedAppBlock).toContain("animation: none");
  });

  it("keeps focus outlines routed through the shared focus-ring token", () => {
    const tokensCss = readFileSync(join(SRC_DIR, "tokens.css"), "utf8");
    const appCss = readFileSync(join(SRC_DIR, "App.css"), "utf8");

    expect(tokensCss).toContain("--focus-ring: 1.5px dotted var(--fg-ink)");
    expect(appCss).toContain("outline: var(--focus-ring)");
  });
});

function extractMediaBlock(css: string, mediaQuery: string) {
  const mediaIndex = css.indexOf(`@media (${mediaQuery})`);
  expect(mediaIndex).toBeGreaterThanOrEqual(0);

  const blockStart = css.indexOf("{", mediaIndex);
  expect(blockStart).toBeGreaterThanOrEqual(0);

  let depth = 0;
  for (let index = blockStart; index < css.length; index += 1) {
    if (css[index] === "{") {
      depth += 1;
    } else if (css[index] === "}") {
      depth -= 1;
      if (depth === 0) {
        return css.slice(blockStart + 1, index);
      }
    }
  }

  throw new Error(`Could not find closing block for ${mediaQuery}`);
}
