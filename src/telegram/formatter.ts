const TELEGRAM_MAX_LENGTH = 4096;

/**
 * Split a long message into chunks that fit within Telegram's message limit.
 * Tries to split at newlines, then spaces, falling back to hard cuts.
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

    let splitAt = remaining.lastIndexOf("\n", TELEGRAM_MAX_LENGTH);
    if (splitAt < TELEGRAM_MAX_LENGTH * 0.3) {
      splitAt = remaining.lastIndexOf(" ", TELEGRAM_MAX_LENGTH);
    }
    if (splitAt < TELEGRAM_MAX_LENGTH * 0.3) {
      splitAt = TELEGRAM_MAX_LENGTH;
    }

    chunks.push(remaining.slice(0, splitAt));
    remaining = remaining.slice(splitAt).trimStart();
  }

  return chunks;
}

/**
 * Escape special characters for Telegram MarkdownV2 format.
 */
export function escapeTelegramMarkdown(text: string): string {
  return text.replace(/([_*\[\]()~`>#+\-=|{}.!\\])/g, "\\$1");
}

/**
 * Convert standard markdown from the AI into Telegram MarkdownV2.
 * Handles bold, italic, code, and preserves line breaks.
 */
export function toTelegramMarkdown(text: string): string {
  // Extract code blocks and inline code first to protect them
  const codeBlocks: string[] = [];
  let processed = text.replace(/```[\s\S]*?```/g, (match) => {
    codeBlocks.push(match);
    return `%%CODEBLOCK${codeBlocks.length - 1}%%`;
  });

  const inlineCode: string[] = [];
  processed = processed.replace(/`[^`]+`/g, (match) => {
    inlineCode.push(match);
    return `%%INLINE${inlineCode.length - 1}%%`;
  });

  // Escape special chars in normal text (not inside code)
  processed = processed.replace(/([_\[\]()~>#+\-=|{}.!\\])/g, "\\$1");

  // Convert **bold** (must come before * italic)
  processed = processed.replace(/\\\*\\\*(.+?)\\\*\\\*/g, "*$1*");
  // Convert *italic*
  processed = processed.replace(/\\\*(.+?)\\\*/g, "_$1_");

  // Restore inline code
  processed = processed.replace(/%%INLINE(\d+)%%/g, (_m, i) => {
    return inlineCode[parseInt(i)];
  });

  // Restore code blocks — convert to Telegram format
  processed = processed.replace(/%%CODEBLOCK(\d+)%%/g, (_m, i) => {
    return codeBlocks[parseInt(i)];
  });

  return processed;
}
