import { readFileSync } from "fs";
import { join } from "path";
import { describe, expect, it } from "vitest";

const APP_CSS = readFileSync(join(process.cwd(), "src", "App.css"), "utf8");
const TOKENS_CSS = readFileSync(join(process.cwd(), "src", "tokens.css"), "utf8");

type CssRule = {
  selectors: string[];
  body: string;
  raw: string;
};

type Rgb = {
  r: number;
  g: number;
  b: number;
};

function parseTopLevelRules(css: string): CssRule[] {
  const rules: CssRule[] = [];
  const stripped = css.replace(/\/\*[\s\S]*?\*\//g, "");
  let cursor = 0;

  while (cursor < stripped.length) {
    const open = stripped.indexOf("{", cursor);
    if (open === -1) {
      break;
    }

    const selectorText = stripped.slice(cursor, open).trim();
    let depth = 1;
    let close = open + 1;

    while (close < stripped.length && depth > 0) {
      if (stripped[close] === "{") {
        depth += 1;
      } else if (stripped[close] === "}") {
        depth -= 1;
      }
      close += 1;
    }

    const body = stripped.slice(open + 1, close - 1).trim();
    if (selectorText && !selectorText.startsWith("@")) {
      rules.push({
        selectors: selectorText.split(",").map((selector) => selector.trim()),
        body,
        raw: `${selectorText} {\n${body}\n}`,
      });
    }

    cursor = close;
  }

  return rules;
}

const APP_RULES = parseTopLevelRules(APP_CSS);
const TOKEN_RULES = parseTopLevelRules(TOKENS_CSS);

function rulesForSelector(selector: string, rules = APP_RULES) {
  return rules.filter((rule) => rule.selectors.includes(selector));
}

function lastCssRule(selector: string, rules = APP_RULES) {
  return rulesForSelector(selector, rules).at(-1)?.raw ?? "";
}

function cssRuleContaining(selector: string, text: string, rules = APP_RULES) {
  return rulesForSelector(selector, rules).find((rule) => rule.raw.includes(text))?.raw ?? "";
}

function lastCssRuleContaining(selector: string, text: string, rules = APP_RULES) {
  return rulesForSelector(selector, rules)
    .filter((rule) => rule.raw.includes(text))
    .at(-1)?.raw ?? "";
}

function tokenValue(token: string, selector = ":root") {
  const tokenRule = rulesForSelector(selector, TOKEN_RULES).at(-1);
  const match = tokenRule?.body.match(new RegExp(`${token}:\\s*([^;]+);`));
  return match?.[1].trim() ?? "";
}

function finalSystemDarkTokenRule() {
  const matches = [
    ...TOKENS_CSS.matchAll(
      /@media \(prefers-color-scheme: dark\)\s*{\s*html:not\(\[data-theme\]\)\s*{([\s\S]*?)\n\s*}\s*\n}/g,
    ),
  ];

  return matches.at(-1)?.[1] ?? "";
}

function resolveTokenValue(token: string, seen = new Set<string>()) {
  if (seen.has(token)) {
    throw new Error(`Circular token reference while resolving ${token}`);
  }

  seen.add(token);
  const value = tokenValue(token);
  const referencedToken = value.match(/^var\((--[\w-]+)\)$/)?.[1];
  return referencedToken ? resolveTokenValue(referencedToken, seen) : value;
}

function resolveTokenColor(token: string, seen = new Set<string>()): Rgb {
  if (seen.has(token)) {
    throw new Error(`Circular token reference while resolving ${token}`);
  }

  seen.add(token);
  const value = tokenValue(token);
  const referencedToken = value.match(/^var\((--[\w-]+)\)$/)?.[1];
  if (referencedToken) {
    return resolveTokenColor(referencedToken, seen);
  }

  const color = parseColor(value);
  if (!color) {
    throw new Error(`Expected ${token} to resolve to a color, got "${value}"`);
  }
  return color;
}

function parseColor(value: string): Rgb | null {
  const hex = value.match(/#([0-9a-f]{3}|[0-9a-f]{6})\b/i)?.[1];
  if (hex) {
    const expanded =
      hex.length === 3
        ? hex
            .split("")
            .map((digit) => digit + digit)
            .join("")
        : hex;

    return {
      r: Number.parseInt(expanded.slice(0, 2), 16),
      g: Number.parseInt(expanded.slice(2, 4), 16),
      b: Number.parseInt(expanded.slice(4, 6), 16),
    };
  }

  const rgb = value.match(/rgba?\(\s*(\d+),\s*(\d+),\s*(\d+)/i);
  if (rgb) {
    return {
      r: Number.parseInt(rgb[1], 10),
      g: Number.parseInt(rgb[2], 10),
      b: Number.parseInt(rgb[3], 10),
    };
  }

  return null;
}

function hsl({ r, g, b }: Rgb) {
  const normalizedR = r / 255;
  const normalizedG = g / 255;
  const normalizedB = b / 255;
  const max = Math.max(normalizedR, normalizedG, normalizedB);
  const min = Math.min(normalizedR, normalizedG, normalizedB);
  const delta = max - min;
  const lightness = (max + min) / 2;

  if (delta === 0) {
    return { h: 0, s: 0, l: lightness };
  }

  const saturation = delta / (1 - Math.abs(2 * lightness - 1));
  const hue =
    max === normalizedR
      ? 60 * (((normalizedG - normalizedB) / delta) % 6)
      : max === normalizedG
        ? 60 * ((normalizedB - normalizedR) / delta + 2)
        : 60 * ((normalizedR - normalizedG) / delta + 4);

  return { h: hue < 0 ? hue + 360 : hue, s: saturation, l: lightness };
}

function relativeLuma({ r, g, b }: Rgb) {
  return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
}

function isWarmPaperColor(color: Rgb) {
  const { h, s, l } = hsl(color);
  return (s <= 0.12 && l >= 0.85) || (h >= 24 && h <= 58 && l >= 0.66);
}

function isPurpleBlue(color: Rgb) {
  const { h, s } = hsl(color);
  return s > 0.18 && h >= 210 && h <= 290;
}

function radiusPx(rule: string) {
  const rawValue = rule.match(/border-radius:\s*([^;]+);/)?.[1].trim() ?? "";
  const value = rawValue.match(/^var\((--[\w-]+)\)$/)?.[1]
    ? resolveTokenValue(rawValue.match(/^var\((--[\w-]+)\)$/)![1])
    : rawValue;
  return value === "0" ? 0 : Number.parseFloat(value.replace("px", ""));
}

function gradientSnippets(css: string) {
  const lines = css.split("\n");
  return lines.flatMap((line, index) =>
    line.includes("linear-gradient") ? [lines.slice(index, index + 8).join("\n")] : [],
  );
}

function colorsInSnippet(snippet: string) {
  const colorValues = [
    ...snippet.matchAll(/#[0-9a-f]{3,6}\b/gi),
    ...snippet.matchAll(/rgba?\(\s*\d+,\s*\d+,\s*\d+(?:,\s*[\d.]+)?\s*\)/gi),
  ];

  return colorValues.flatMap((match) => {
    const color = parseColor(match[0]);
    return color ? [color] : [];
  });
}

describe("app viewport layout CSS", () => {
  it("keeps the shell viewport-fixed and prevents body scrolling", () => {
    expect(APP_CSS).toMatch(/html,\s*body,\s*#root\s*{[^}]*overflow:\s*hidden;/s);
    expect(APP_CSS).toMatch(/\.app-shell\s*{[^}]*height:\s*100dvh;[^}]*overflow:\s*hidden;/s);
    expect(APP_CSS).not.toContain("min-height: calc(100vh - 58px)");
  });

  it("keeps the file pane as its own scroll container", () => {
    expect(APP_CSS).toMatch(/\.file-list\s*{[^}]*flex:\s*1;[^}]*min-height:\s*0;[^}]*overflow:\s*auto;/s);
  });

  it("keeps the comment pane locally scrollable", () => {
    const commentDockBodyRule = cssRuleContaining(".comment-dock-body", "overflow-y: auto");

    expect(commentDockBodyRule).toContain("overflow-y: auto");
    expect(commentDockBodyRule).toContain("scroll-padding-block: 24px");
  });

  it("allows a wider document editing measure", () => {
    const editorContentRule = lastCssRule(".code-editor-host .cm-content");

    expect(editorContentRule).toContain("118ch");
    expect(editorContentRule).not.toContain("72ch");
    expect(editorContentRule).toContain("font-family: var(--font-body)");
    expect(editorContentRule).toContain("font-size: 16px");
    expect(editorContentRule).toContain("line-height: 1.65");
  });

  it("keeps editor surfaces and ink theme-aware", () => {
    expect(lastCssRule(".center-panel")).toContain("background: var(--ledger-canvas)");
    expect(lastCssRule(".editor-main")).toContain("background: var(--ledger-canvas)");
    expect(lastCssRule(".code-editor-host")).toContain("background: var(--ledger-canvas)");
    expect(lastCssRule(".code-editor-host .cm-editor")).toContain("background: var(--ledger-canvas)");
    expect(lastCssRule(".code-editor-host .cm-gutters")).toContain("background: var(--editor-gutter-bg)");
    expect(lastCssRule(".code-editor-host .cm-content")).toContain("color: var(--editor-ink)");
    expect(lastCssRule(".code-editor-host .cm-panels")).toContain("background: var(--ledger-panel)");
  });

  it("keeps the outline behind an explicit dock toggle", () => {
    expect(lastCssRule(".document-outline-toggle-row")).toContain("flex: 0 0 auto");
    expect(lastCssRule(".document-outline-toggle")).toContain("font-size: 11px");
  });

  it("keeps selected dock thread controls centered with padded messages", () => {
    const toolbarRule = lastCssRule(".comment-dock-card:not(.is-expanded-thread-card) .thread-card-toolbar");
    const actionRule = lastCssRule(".comment-dock-card:not(.is-expanded-thread-card) .thread-card-toolbar-actions");
    const buttonRule = lastCssRule(
      ".comment-dock-card:not(.is-expanded-thread-card) .thread-card-toolbar-actions .ghost-button",
    );
    const messageRule = lastCssRule(".comment-dock-card:not(.is-expanded-thread-card) .thread-message");

    expect(toolbarRule).toContain("justify-content: center");
    expect(actionRule).toContain("grid-template-columns: repeat(4, minmax(0, 1fr))");
    expect(buttonRule).toContain("width: 100%");
    expect(messageRule).toContain("padding: 14px 16px 15px");
  });
});

describe("Clerk-ledger visual system CSS", () => {
  it("keeps the Clerk neutral canvas, dark rail, and teal accent token families intact", () => {
    expect(resolveTokenColor("--ledger-sidebar-bg")).toEqual({ r: 30, g: 31, b: 33 });
    expect(relativeLuma(resolveTokenColor("--ledger-sidebar-bg"))).toBeLessThan(0.14);
    expect(resolveTokenColor("--surface-chrome")).toEqual(resolveTokenColor("--ledger-sidebar-bg"));
    expect(resolveTokenColor("--ledger-accent")).toEqual({ r: 23, g: 60, b: 59 });
    expect(tokenValue("--fg-on-dark")).not.toEqual("");

    for (const token of ["--ledger-canvas", "--ledger-panel", "--surface-page", "--surface-inset"]) {
      const color = resolveTokenColor(token);

      expect(isWarmPaperColor(color), `${token} should stay in the white/panel neutral range`).toBe(true);
      expect(isPurpleBlue(color), `${token} must not drift into blue/purple`).toBe(false);
    }

    expect(radiusPx(`border-radius: ${resolveTokenValue("--radius-md")};`)).toBeLessThanOrEqual(6);
    expect(radiusPx(`border-radius: ${resolveTokenValue("--radius-sm")};`)).toBeLessThanOrEqual(4);
  });

  it("keeps the topbar white, the file rail dark, and editor surfaces neutral", () => {
    const topbarRule = lastCssRule(".topbar");

    expect(topbarRule).toContain("background: var(--ledger-canvas)");
    expect(topbarRule).toContain("color: var(--ledger-ink)");
    expect(topbarRule).toContain("box-shadow: none");
    expect(topbarRule).not.toContain("linear-gradient");

    expect(lastCssRule(".left-panel")).toContain("background: var(--ledger-sidebar-bg)");
    expect(lastCssRule(".workspace-rail")).toContain("background: var(--ledger-sidebar-bg)");
    expect(lastCssRule(".center-panel")).toContain("background: var(--ledger-canvas)");
    expect(lastCssRule(".editor-main")).toContain("background: var(--ledger-canvas)");
    expect(lastCssRule(".code-editor-host")).toContain("background: var(--ledger-canvas)");
    expect(lastCssRule(".comment-dock")).toContain("background: var(--ledger-panel)");
  });

  it("uses theme-aware control surfaces instead of hard-coded white buttons", () => {
    expect(tokenValue("--ledger-control-bg")).toBe("#ffffff");
    expect(tokenValue("--ledger-control-on-accent")).toBe("#ffffff");
    expect(tokenValue("--ledger-control-bg", "html[data-theme=\"dark\"]")).toBe("var(--ledger-panel)");
    expect(tokenValue("--ledger-control-on-accent", "html[data-theme=\"dark\"]")).toBe("#111214");

    expect(lastCssRule(".ghost-button")).toContain("background: var(--ledger-control-bg)");
    expect(lastCssRule(".topbar .ghost-button")).toContain("background: var(--ledger-control-bg)");
    expect(lastCssRule(".primary-button")).toContain("color: var(--ledger-control-on-accent)");
    expect(lastCssRule(".seg button.on")).toContain("color: var(--ledger-control-on-accent)");
    expect(lastCssRule(".thread-message--assistant")).toContain("background: var(--ledger-control-bg)");
  });

  it("keeps system dark mode on the Clerk ledger palette", () => {
    const systemDarkRule = finalSystemDarkTokenRule();

    expect(systemDarkRule).toContain("color-scheme: dark");
    expect(systemDarkRule).toContain("--ledger-canvas: #1e1f21");
    expect(systemDarkRule).toContain("--ledger-panel: #262729");
    expect(systemDarkRule).toContain("--fg-ink: var(--ledger-ink)");
    expect(systemDarkRule).toContain("--surface-page: var(--ledger-canvas)");
    expect(systemDarkRule).toContain("--editor-ink: var(--ledger-ink)");
    expect(systemDarkRule).toContain("--editor-ink-secondary: var(--ledger-ink-soft)");
    expect(systemDarkRule).toContain("--editor-ink-tertiary: var(--ledger-ink-muted)");
    expect(systemDarkRule).toContain("--ledger-control-bg: var(--ledger-panel)");
    expect(systemDarkRule).toContain("--ledger-control-on-accent: #111214");
    expect(systemDarkRule).not.toContain("--fg-ink: #ecdfc8");
  });

  it("keeps cards squared off with restrained borders and shadows", () => {
    for (const selector of [
      ".primary-button",
      ".ghost-button",
      ".code-editor-host .cm-editor",
      ".thread-card-inner",
      ".empty-state-card",
      ".thread-section",
      ".thread-textarea",
      ".thread-input",
      ".thread-select",
    ]) {
      expect(
        radiusPx(lastCssRuleContaining(selector, "border-radius")),
        `${selector} should not return to rounded card styling`,
      ).toBeLessThanOrEqual(6);
    }

    expect(lastCssRule(".app-layout")).toContain("box-shadow: none");
    expect(lastCssRule(".code-editor-host .cm-editor")).toContain("box-shadow: var(--ledger-shadow-card)");
    expect(lastCssRuleContaining(".thread-card-inner", "box-shadow")).toContain(
      "box-shadow: var(--ledger-shadow-card)",
    );
    expect(lastCssRuleContaining(".thread-section", "box-shadow")).toContain(
      "box-shadow: var(--ledger-shadow-card)",
    );
    expect(lastCssRule(".code-editor-host .cm-editor")).toContain("border: 1px solid var(--ledger-hairline)");
    expect(lastCssRuleContaining(".thread-section", "border:")).toContain(
      "border: 1px solid var(--ledger-hairline)",
    );
  });

  it("keeps the core layout free of decorative gradients and blocks purple/blue gradient drift", () => {
    for (const selector of [
      ".topbar",
      ".app-layout",
      ".left-panel",
      ".workspace-rail",
      ".center-panel",
      ".editor-main",
      ".code-editor-host",
      ".comment-dock",
      ".primary-button",
    ]) {
      expect(lastCssRule(selector), `${selector} should use flat tokenized surfaces`).not.toContain("linear-gradient");
    }

    const purpleBlueGradient = gradientSnippets(APP_CSS).find((snippet) =>
      colorsInSnippet(snippet).some((color) => isPurpleBlue(color)),
    );

    expect(purpleBlueGradient ?? "").toEqual("");
  });

  it("defines every global CSS custom property used by the app styles", () => {
    const definedTokens = new Set(
      [...TOKENS_CSS.matchAll(/(--[\w-]+):\s*[^;]+;/g)].map((match) => match[1]),
    );
    const locallyScopedTokens = new Set(["--comment-dock-width", "--outline-depth"]);
    const usedTokens = [...APP_CSS.matchAll(/var\((--[\w-]+)/g)].map((match) => match[1]);
    const missingTokens = [...new Set(usedTokens)].filter(
      (token) => !definedTokens.has(token) && !locallyScopedTokens.has(token),
    );

    expect(missingTokens).toEqual([]);
  });
});
