import type { Tier } from "./router.js";

// ---------------------------------------------------------------------------
// Fast local classifier — replaces GPT-4.1 LLM classifier.
// Runs in microseconds instead of up to 8 seconds.
// Default tier is "standard" (safe for any message).
// ---------------------------------------------------------------------------

// Whole-message matches for trivial/casual messages (lowercase, trimmed)
const FAST_EXACT = new Set([
  "hello", "hi", "hey", "yo", "sup", "hiya", "howdy",
  "good morning", "good evening", "good night", "good afternoon",
  "morning", "evening", "night",
  "thanks", "thank you", "thx", "ty", "cheers", "much appreciated",
  "bye", "goodbye", "see you", "later", "cya", "gotta go",
  "how are you", "how's it going", "what's up", "wassup", "how you doing",
  "lol", "haha", "hahaha", "lmao",
  "what time is it", "what day is it", "what's the date",
  "who are you", "what are you", "what's your name",
]);

// Patterns for slightly varied but still trivial messages
const FAST_PATTERNS: RegExp[] = [
  /^(?:hey|hi|hello|yo|sup|hiya|howdy)\b[\s!.,?]*$/i,
  /^good (?:morning|evening|night|afternoon)\b[\s!.,?]*$/i,
  /^(?:thanks?|thank you|thx|ty|cheers)\b[\s!.,]*$/i,
  /^(?:bye|goodbye|see you|later|cya)\b[\s!.,]*$/i,
  /^what (?:time|day|date) is it\??$/i,
  /^(?:who|what) are you\??$/i,
];

// Max length for a message to qualify as FAST
const FAST_MAX_LENGTH = 60;

// Technical content signals that disqualify a short message from FAST
const TECHNICAL_RE = /[`{}()<>|]|\.\w{1,5}\b|\b(?:error|bug|fix|code|file|function|class|import|debug|test|build|deploy|run|install|config|server|api|database|query|commit|merge|branch|refactor)\b/i;

// ---------------------------------------------------------------------------
// Premium detection
// ---------------------------------------------------------------------------

// Word-boundary keywords that indicate complex/premium tasks
const PREMIUM_KEYWORDS: string[] = [
  "architecture", "architect", "architectural",
  "trade-off", "tradeoff",
  "pros and cons",
  "system design",
  "design system",
  "strategic", "strategy",
  "scalability", "scaling strategy",
  "migration plan", "migration strategy",
  "performance analysis", "performance audit",
  "security audit", "security review", "threat model",
  "deep dive", "deep analysis",
  "root cause analysis",
  "design doc", "design document",
  "rfc", "adr",
];

// Phrase patterns that strongly indicate complex work
const PREMIUM_PHRASES: RegExp[] = [
  /\b(?:design|architect|plan)\b.*\b(?:system|service|platform|infrastructure)\b/i,
  /\b(?:compare|evaluate|analyze)\b.*\b(?:approach|option|solution|strategy|trade.?off)\b/i,
  /\bhow should (?:we|i)\b.*\b(?:architect|design|structure|organize|scale)\b/i,
  /\bwhat(?:'s| is) the best (?:way|approach|strategy)\b/i,
  /\b(?:explain|describe)\b.*\b(?:in detail|thoroughly|comprehensively)\b/i,
  /\b(?:debug|diagnose|investigate)\b.*\b(?:complex|intricate|intermittent|race condition|deadlock)\b/i,
  /\b(?:refactor|restructure|rearchitect)\b.*\b(?:system|codebase|module|service)\b/i,
];

// Premium messages should be substantial
const PREMIUM_MIN_LENGTH = 30;

// ---------------------------------------------------------------------------
// Main classify function
// ---------------------------------------------------------------------------

/** Word-boundary match that avoids partial-word hits (e.g. "ui" ≠ "fruit"). */
function wordMatch(text: string, keyword: string): boolean {
  const escaped = keyword.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`\\b${escaped}\\b`, "i").test(text);
}

/**
 * Classify a message tier using fast local heuristics.
 * Synchronous — no LLM calls, no network, no I/O.
 */
export function classify(message: string): Tier {
  const text = message.trim();
  const lower = text.toLowerCase();

  // --- FAST detection ---
  if (text.length <= FAST_MAX_LENGTH) {
    if (FAST_EXACT.has(lower)) return "fast";

    // Pattern match — only if no technical content
    if (!TECHNICAL_RE.test(text)) {
      for (const pattern of FAST_PATTERNS) {
        if (pattern.test(text)) return "fast";
      }
    }
  }

  // --- PREMIUM detection ---
  if (text.length >= PREMIUM_MIN_LENGTH) {
    // Phrase patterns (strongest signal)
    for (const pattern of PREMIUM_PHRASES) {
      if (pattern.test(text)) return "premium";
    }

    // Keyword matches
    for (const keyword of PREMIUM_KEYWORDS) {
      if (wordMatch(lower, keyword)) return "premium";
    }
  }

  // --- Default: STANDARD ---
  return "standard";
}

/** No-op — the local classifier has no session to tear down. */
export function stopClassifier(): void {}
