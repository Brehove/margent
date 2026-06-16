import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "fs";
import { join } from "path";

const SRC_DIR = join(__dirname, "..", "src");
const BROWSER_DIALOG_PATTERN = /\bwindow\.(prompt|confirm|alert)\b/;

describe("browser modal dialog guard", () => {
  it("keeps prompt, confirm, and alert out of production source", () => {
    const offenders = listSourceFiles(SRC_DIR).filter((filePath) =>
      BROWSER_DIALOG_PATTERN.test(readFileSync(filePath, "utf8")),
    );

    expect(offenders).toEqual([]);
  });
});

function listSourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry);
    const stat = statSync(path);

    if (stat.isDirectory()) {
      return listSourceFiles(path);
    }

    return /\.(ts|tsx|js|jsx)$/.test(entry) ? [path] : [];
  });
}
