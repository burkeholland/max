const TELEGRAM_MAX_LENGTH = 4096;

/**
 * Split a long message into chunks that fit within Telegram's message limit.
 * Respects code block boundaries — re-opens/closes fences when splitting
 * inside a code block so each chunk has valid MarkdownV2 syntax.
 */
export function chunkMessage(text: string): string[] {
  if (text.length <= TELEGRAM_MAX_LENGTH) {
    return [text];
  }

  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > 0) {
    if (remaining.length <= TELEGRAM_MAX_LENGTH) {
      chunks.push(remaining);
      break;
    }

    // Determine if we're inside a code block at the split boundary
    const window = remaining.slice(0, TELEGRAM_MAX_LENGTH);
    const fenceMatches = [...window.matchAll(/```/g)];
    const insideCodeBlock = fenceMatches.length % 2 !== 0;

    let splitAt: number;
    if (insideCodeBlock) {
      // Find the last newline inside the code block to split cleanly
      splitAt = window.lastIndexOf("\n");
      if (splitAt < TELEGRAM_MAX_LENGTH * 0.2) {
        splitAt = TELEGRAM_MAX_LENGTH - 4; // leave room for closing ```
      }
    } else {
      // Prefer splitting at paragraph breaks, then newlines, then spaces
      splitAt = window.lastIndexOf("\n\n");
      if (splitAt < TELEGRAM_MAX_LENGTH * 0.3) {
        splitAt = window.lastIndexOf("\n");
      }
      if (splitAt < TELEGRAM_MAX_LENGTH * 0.3) {
        splitAt = window.lastIndexOf(" ");
      }
      if (splitAt < TELEGRAM_MAX_LENGTH * 0.3) {
        splitAt = TELEGRAM_MAX_LENGTH;
      }
    }

    let chunk = remaining.slice(0, splitAt);
    remaining = remaining.slice(splitAt).trimStart();

    if (insideCodeBlock) {
      // Close the code block in this chunk and re-open in the next
      chunk += "\n```";
      // Find the language tag from the opening fence
      const openFence = chunk.match(/```([a-z]*)\n/);
      const lang = openFence?.[1] || "";
      remaining = "```" + lang + "\n" + remaining;
    }

    chunks.push(chunk);
  }

  return chunks;
}

/**
 * Escape special characters for Telegram MarkdownV2 plain text segments.
 */
function escapeSegment(text: string): string {
  return text.replace(/([_*\[\]()~`>#+\-=|{}.!\\])/g, "\\$1");
}

/**
 * Convert a markdown table into a readable mobile-friendly list.
 * Returns already-escaped MarkdownV2 text ready to be stashed.
 * *Casa del Poeta* — $383 · ⭐ 4.89
 */
function convertTable(table: string): string {
  const rows = table.trim().split("\n").filter(row => !/^\|[-| :]+\|$/.test(row.trim()));
  const parsed = rows.map(row =>
    row.split("|").map(c => c.trim()).filter(Boolean)
  );
  if (parsed.length === 0) return "";

  // Skip header row, format data rows as: *first col* — rest · rest
  const dataRows = parsed.length > 1 ? parsed.slice(1) : parsed;
  return dataRows.map(cols => {
    if (cols.length === 0) return "";
    const first = `*${escapeSegment(cols[0])}*`;
    const rest = cols.slice(1).map(c => escapeSegment(c)).join(" · ");
    return rest ? `${first} — ${rest}` : first;
  }).join("\n");
}

/**
 * Convert standard markdown from the AI into Telegram MarkdownV2.
 * Handles bold, italic, code blocks, headers, tables, and horizontal rules.
 */
export function toTelegramMarkdown(text: string): string {
  // 1. Stash code blocks (protect from processing)
  const stash: string[] = [];
  const stashToken = (s: string) => { stash.push(s); return `\x00STASH${stash.length - 1}\x00`; };

  let out = text;

  // Stash fenced code blocks
  out = out.replace(/```([a-z]*)\n?([\s\S]*?)```/g, (_m, lang, code) =>
    stashToken("```" + (lang || "") + "\n" + code.trim() + "\n```")
  );

  // Stash inline code
  out = out.replace(/`([^`\n]+)`/g, (_m, code) =>
    stashToken("`" + code + "`")
  );

  // 2. Convert tables before any escaping — stash result to avoid double-escaping
  out = out.replace(/(?:^\|.+\|[ \t]*$\n?)+/gm, (table) =>
    stashToken(convertTable(table) + "\n")
  );

  // 3. Convert headers → bold
  out = out.replace(/^#{1,6}\s+(.+)$/gm, (_m, title) => `**${title.trim()}**`);

  // 4. Remove horizontal rules
  out = out.replace(/^[-*_]{3,}\s*$/gm, "");

  // 5. Extract bold/italic markers before escaping
  const boldParts: string[] = [];
  out = out.replace(/\*\*(.+?)\*\*/g, (_m, inner) => {
    boldParts.push(inner);
    return `\x00BOLD${boldParts.length - 1}\x00`;
  });

  const italicParts: string[] = [];
  out = out.replace(/\*(.+?)\*/g, (_m, inner) => {
    italicParts.push(inner);
    return `\x00ITALIC${italicParts.length - 1}\x00`;
  });

  // 6. Escape everything that remains
  out = escapeSegment(out);

  // 7. Restore bold and italic with escaped inner text
  out = out.replace(/\x00BOLD(\d+)\x00/g, (_m, i) => `*${escapeSegment(boldParts[+i])}*`);
  out = out.replace(/\x00ITALIC(\d+)\x00/g, (_m, i) => `_${escapeSegment(italicParts[+i])}_`);

  // 8. Restore stashed code blocks/inline code
  out = out.replace(/\x00STASH(\d+)\x00/g, (_m, i) => stash[+i]);

  // 9. Clean up excessive blank lines
  out = out.replace(/\n{3,}/g, "\n\n");

  return out.trim();
}
