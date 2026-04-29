// Feishu has a per-message size cap; ~30 KB is safe for both text and
// interactive-card payloads. We chunk just under that to leave room for
// JSON wrapping.
const FEISHU_MAX_LENGTH = 28_000;

/**
 * Split a long message into chunks that fit within Feishu's message limit.
 * Same algorithm as the Telegram chunker — try newlines, then spaces,
 * then a hard cut.
 */
export function chunkMessage(text: string): string[] {
  if (text.length <= FEISHU_MAX_LENGTH) {
    return [text];
  }

  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > 0) {
    if (remaining.length <= FEISHU_MAX_LENGTH) {
      chunks.push(remaining);
      break;
    }

    let splitAt = remaining.lastIndexOf("\n", FEISHU_MAX_LENGTH);
    if (splitAt < FEISHU_MAX_LENGTH * 0.3) {
      splitAt = remaining.lastIndexOf(" ", FEISHU_MAX_LENGTH);
    }
    if (splitAt < FEISHU_MAX_LENGTH * 0.3) {
      splitAt = FEISHU_MAX_LENGTH;
    }

    chunks.push(remaining.slice(0, splitAt));
    remaining = remaining.slice(splitAt).trimStart();
  }

  return chunks;
}

/** Build a Feishu interactive-card payload (stringified JSON) from markdown. */
export function buildCardContent(markdown: string): string {
  return JSON.stringify({
    config: { wide_screen_mode: true },
    elements: [
      {
        tag: "markdown",
        content: markdown,
      },
    ],
  });
}

/** Build a plain text message payload (stringified JSON) for Feishu. */
export function buildTextContent(text: string): string {
  return JSON.stringify({ text });
}
