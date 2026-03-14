import { describe, it, expect } from "vitest";
import { chunkMessage, toTelegramMarkdown } from "./formatter.js";

describe("chunkMessage", () => {
  it("returns single chunk for short messages", () => {
    expect(chunkMessage("hello")).toEqual(["hello"]);
  });

  it("returns single chunk for exactly 4096 chars", () => {
    const msg = "a".repeat(4096);
    expect(chunkMessage(msg)).toEqual([msg]);
  });

  it("splits long messages at newlines", () => {
    const line = "x".repeat(2000) + "\n";
    const msg = line.repeat(3); // 6003 chars
    const chunks = chunkMessage(msg);
    expect(chunks.length).toBeGreaterThan(1);
    // Reassembled content should match (accounting for trimmed whitespace at splits)
    const reassembled = chunks.join("");
    expect(reassembled.replace(/\s+/g, "")).toBe(msg.replace(/\s+/g, ""));
  });

  it("splits at spaces when no good newline break exists", () => {
    const words = Array(1000).fill("word").join(" "); // ~5000 chars
    const chunks = chunkMessage(words);
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(4096);
    }
  });

  it("hard-cuts when no spaces or newlines exist", () => {
    const msg = "a".repeat(8192);
    const chunks = chunkMessage(msg);
    expect(chunks.length).toBe(2);
    expect(chunks[0].length).toBe(4096);
    expect(chunks[1].length).toBe(4096);
  });

  it("handles empty string", () => {
    expect(chunkMessage("")).toEqual([""]);
  });
});

describe("toTelegramMarkdown", () => {
  it("passes through plain text with special chars escaped", () => {
    const result = toTelegramMarkdown("Hello world");
    expect(result).toBe("Hello world");
  });

  it("converts **bold** to *bold*", () => {
    const result = toTelegramMarkdown("This is **bold** text");
    expect(result).toContain("*bold*");
    // Should not contain the markdown ** markers
    expect(result).not.toContain("**");
  });

  it("converts *italic* to _italic_", () => {
    const result = toTelegramMarkdown("This is *italic* text");
    expect(result).toContain("_italic_");
  });

  it("preserves fenced code blocks", () => {
    const input = "Here is code:\n```js\nconst x = 1;\n```";
    const result = toTelegramMarkdown(input);
    expect(result).toContain("```js");
    expect(result).toContain("const x = 1;");
    expect(result).toContain("```");
  });

  it("preserves inline code", () => {
    const result = toTelegramMarkdown("Use `npm install` to install");
    expect(result).toContain("`npm install`");
  });

  it("converts headers to bold", () => {
    const result = toTelegramMarkdown("# Title\n## Subtitle");
    // Headers become bold — should not have # markers
    expect(result).not.toContain("#");
    expect(result).toContain("*Title*");
    expect(result).toContain("*Subtitle*");
  });

  it("removes horizontal rules", () => {
    const result = toTelegramMarkdown("above\n---\nbelow");
    expect(result).not.toContain("---");
    expect(result).toContain("above");
    expect(result).toContain("below");
  });

  it("escapes special Telegram MarkdownV2 characters in plain text", () => {
    const result = toTelegramMarkdown("Price: $5.00 (50% off!)");
    // Dots, parens, exclamation should be escaped
    expect(result).toContain("\\.");
    expect(result).toContain("\\(");
    expect(result).toContain("\\)");
    expect(result).toContain("\\!");
  });

  it("converts markdown tables to mobile-friendly list", () => {
    const table = "| Name | Price |\n|------|-------|\n| Item1 | $10 |\n| Item2 | $20 |";
    const result = toTelegramMarkdown(table);
    // Tables become bold-first-col format
    expect(result).toContain("*Item1*");
    expect(result).toContain("*Item2*");
    // Should not contain pipe characters (table syntax)
    expect(result).not.toContain("|");
  });

  it("collapses excessive blank lines", () => {
    const result = toTelegramMarkdown("a\n\n\n\n\nb");
    // At most two newlines in a row
    expect(result).not.toMatch(/\n{3,}/);
  });
});
