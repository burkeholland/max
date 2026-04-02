import { addMemory, findSimilarMemory } from "../store/db.js";

type MemoryCategory = "preference" | "fact" | "project" | "person" | "routine";

interface ExtractedMemory {
  category: MemoryCategory;
  content: string;
}

// Patterns that signal memorable information in user messages.
// Each entry: [regex, category, capture group index for the content].
const PATTERNS: [RegExp, MemoryCategory, number][] = [
  // Preferences
  [/\bi (?:always |usually )?prefer\s+(.{5,80}?)(?:\.|,|$)/i, "preference", 1],
  [/\bi (?:always |usually )?use\s+(.{3,60}?)(?:\s+(?:for|when|because)\b.{0,80})?(?:\.|,|$)/i, "preference", 1],
  [/\bi (?:don'?t |never )(?:like|use|want)\s+(.{3,80}?)(?:\.|,|$)/i, "preference", 1],
  [/\bi always\s+(.{5,80}?)(?:\.|,|$)/i, "preference", 1],
  [/\bi never\s+(.{5,80}?)(?:\.|,|$)/i, "preference", 1],

  // Identity / facts
  [/\bmy name is\s+(.{2,40}?)(?:\.|,|$)/i, "fact", 1],
  [/\bi(?:'m| am) (?:a |an )?(.{3,60}?)(?:\.|,|$)/i, "fact", 1],
  [/\bi work (?:at|for)\s+(.{2,60}?)(?:\.|,|$)/i, "fact", 1],
  [/\bi live in\s+(.{2,60}?)(?:\.|,|$)/i, "fact", 1],

  // Projects
  [/\b(?:the |our |my )?repo(?:sitory)? is (?:at )?\s*(.{5,100}?)(?:\.|,|$)/i, "project", 1],
  [/\bwe use\s+(.{3,60}?)\s+for\s+(.{3,60}?)(?:\.|,|$)/i, "project", 0],
  [/\b(?:our|the) stack (?:is|includes)\s+(.{5,100}?)(?:\.|,|$)/i, "project", 1],
  [/\b(?:our|the) (?:tech|technology) stack\b.{0,20}\b(?:is|includes)\s+(.{5,100}?)(?:\.|,|$)/i, "project", 1],

  // People
  [/\b(\w+) is (?:my |our )(.{3,60}?)(?:\.|,|$)/i, "person", 0],

  // Routines
  [/\bevery (?:day|morning|evening|week|monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b.{0,10}\bi\s+(.{5,80}?)(?:\.|,|$)/i, "routine", 0],

  // Explicit memory requests (these also get handled by the LLM's remember tool,
  // but capturing them here ensures they're saved even if the LLM doesn't call it)
  [/\bremember (?:that |this:?\s*)(.{5,200}?)(?:\.|$)/i, "fact", 1],
  [/\bdon'?t forget (?:that |this:?\s*)(.{5,200}?)(?:\.|$)/i, "fact", 1],
  [/\bkeep in mind (?:that |this:?\s*)(.{5,200}?)(?:\.|$)/i, "fact", 1],
];

/**
 * Extract memorable facts from a user message using pattern matching.
 * Returns extracted memories that don't already exist in the store.
 */
export function extractMemories(userMessage: string): ExtractedMemory[] {
  // Strip channel tags
  const text = userMessage
    .replace(/^\[via (?:telegram|tui)\]\s*/i, "")
    .trim();

  if (text.length < 10) return [];

  const results: ExtractedMemory[] = [];

  for (const [pattern, category, groupIndex] of PATTERNS) {
    const match = text.match(pattern);
    if (!match) continue;

    let content: string;
    if (groupIndex === 0) {
      content = match[0].trim();
    } else {
      content = match[groupIndex]?.trim() ?? "";
    }

    if (content.length < 3 || content.length > 200) continue;

    // Skip if a similar memory already exists
    if (findSimilarMemory(content)) continue;

    results.push({ category, content });
  }

  return results;
}

/**
 * Extract and save memories from a user message. Non-throwing.
 * Returns the number of memories saved.
 */
export function extractAndSaveMemories(userMessage: string): number {
  try {
    const memories = extractMemories(userMessage);
    for (const mem of memories) {
      addMemory(mem.category, mem.content, "auto");
    }
    return memories.length;
  } catch {
    return 0;
  }
}
