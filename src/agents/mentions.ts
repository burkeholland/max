// ---------------------------------------------------------------------------
// @mention parser + sticky session state
// ---------------------------------------------------------------------------

import { listAgents } from "./registry.js";

export interface MentionResult {
  /** The agent slug extracted from the mention, or undefined if none. */
  agent?: string;
  /** Whether this is a @max mention (return to orchestrator). */
  isMaxMention: boolean;
  /** The prompt text with the @mention stripped. */
  text: string;
}

/** Known agent slugs, refreshed from the registry. */
function getKnownSlugs(): Set<string> {
  return new Set(listAgents().map((a) => a.slug));
}

/**
 * Parse an @mention from the beginning of a message.
 * Returns the agent slug and stripped text.
 */
export function parseMention(text: string): MentionResult {
  // Strip channel tags first
  const cleaned = text.replace(/^\[via (?:telegram|tui)\]\s*/i, "");
  const match = cleaned.match(/^@([\w-]+)\s*([\s\S]*)/);

  if (!match) {
    return { isMaxMention: false, text: cleaned };
  }

  const mentioned = match[1].toLowerCase();
  const remainder = match[2].trim();

  // @max → return to orchestrator
  if (mentioned === "max") {
    return { isMaxMention: true, text: remainder || cleaned };
  }

  // Check if the mentioned name is a known agent
  const known = getKnownSlugs();
  if (known.has(mentioned)) {
    return { agent: mentioned, isMaxMention: false, text: remainder || cleaned };
  }

  // Unknown @mention — leave the message as-is
  return { isMaxMention: false, text: cleaned };
}

// ---------------------------------------------------------------------------
// Sticky session state (per-channel, in-memory, resets on restart)
// ---------------------------------------------------------------------------

const stickyAgents = new Map<string, string>();

/** Get the sticky agent for a channel. */
export function getStickyAgent(channel: string): string | undefined {
  return stickyAgents.get(channel);
}

/** Set a sticky agent for a channel. */
export function setStickyAgent(channel: string, agentSlug: string): void {
  stickyAgents.set(channel, agentSlug);
}

/** Clear the sticky agent for a channel (return to Max). */
export function clearStickyAgent(channel: string): void {
  stickyAgents.delete(channel);
}

/** Get all sticky sessions (for debugging / /agent command). */
export function getAllStickyAgents(): Map<string, string> {
  return new Map(stickyAgents);
}
