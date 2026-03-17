import { getState, setState } from "../store/db.js";
import { classifyWithLLM } from "./classifier.js";
import type { CopilotClient } from "@github/copilot-sdk";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type Tier = "fast" | "standard" | "premium";

export interface OverrideRule {
  name: string;
  keywords: string[];
  model: string;
}

export interface RouterConfig {
  enabled: boolean;
  tierModels: Record<Tier, string>;
  overrides: OverrideRule[];
  cooldownMessages: number;
}

export interface RouteResult {
  model: string;
  tier: Tier | null;
  overrideName?: string;
  switched: boolean;
  routerMode: "auto" | "manual";
}

// ---------------------------------------------------------------------------
// Default configuration
// ---------------------------------------------------------------------------

const DEFAULT_CONFIG: RouterConfig = {
  enabled: false,
  tierModels: {
    fast: "gpt-4.1",
    standard: "claude-sonnet-4.6",
    premium: "claude-opus-4.6",
  },
  overrides: [
    {
      name: "design",
      keywords: [
        "design", "ui", "ux", "css", "layout", "styling", "visual",
        "mockup", "wireframe", "frontend design", "tailwind", "responsive",
      ],
      model: "claude-opus-4.6",
    },
  ],
  cooldownMessages: 2,
};

// ---------------------------------------------------------------------------
// Module-level state
// ---------------------------------------------------------------------------

let messagesSinceSwitch = 0;

// Short replies that should inherit the previous turn's tier
const FOLLOW_UP_PATTERNS = [
  "yes", "no", "do it", "go ahead", "sure", "sounds good", "looks good",
  "perfect", "+1", "please", "yep", "yup", "nope", "nah", "ok", "okay",
  "got it", "cool", "nice", "great", "alright", "right",
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Strip channel prefixes and trim whitespace. */
function sanitize(prompt: string): string {
  return prompt
    .replace(/^\[via telegram\]\s*/i, "")
    .replace(/^\[via tui\]\s*/i, "")
    .trim();
}

/** Word-boundary match that avoids partial-word hits (e.g. "ui" ≠ "fruit"). */
function wordMatch(text: string, keyword: string): boolean {
  const escaped = keyword.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`\\b${escaped}\\b`, "i").test(text);
}

// ---------------------------------------------------------------------------
// Config management
// ---------------------------------------------------------------------------

export function getRouterConfig(): RouterConfig {
  const stored = getState("router_config");
  if (stored) {
    try {
      return { ...DEFAULT_CONFIG, ...JSON.parse(stored) };
    } catch {
      return { ...DEFAULT_CONFIG };
    }
  }
  return { ...DEFAULT_CONFIG };
}

export function updateRouterConfig(partial: Partial<RouterConfig>): RouterConfig {
  const current = getRouterConfig();
  const merged: RouterConfig = {
    ...current,
    ...partial,
    tierModels: {
      ...current.tierModels,
      ...(partial.tierModels ?? {}),
    },
    overrides: partial.overrides ?? current.overrides,
  };
  setState("router_config", JSON.stringify(merged));
  return merged;
}

// ---------------------------------------------------------------------------
// Classification
// ---------------------------------------------------------------------------

/**
 * Classify a message using GPT-4.1. Falls back to "standard" if the LLM
 * is unavailable. Background tasks and follow-ups are handled deterministically.
 */
async function classifyMessage(
  prompt: string,
  recentTiers: Tier[],
  client?: CopilotClient,
): Promise<Tier> {
  const text = sanitize(prompt);
  const lower = text.toLowerCase();

  // Background tasks → always standard
  if (lower.startsWith("[background task completed]")) return "standard";

  // Short follow-ups inherit the previous tier
  if (text.length < 20 && recentTiers.length > 0) {
    const isFollowUp = FOLLOW_UP_PATTERNS.some((p) => lower === p || lower === p + ".");
    if (isFollowUp) return recentTiers[0];
  }

  // LLM classification
  if (client) {
    const tier = await classifyWithLLM(client, text);
    if (tier) {
      console.log(`[max] Classifier: ${tier}`);
      return tier;
    }
  }

  // Fallback — standard is always safe
  console.log(`[max] Classifier (fallback): standard`);
  return "standard";
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

export async function resolveModel(
  prompt: string,
  currentModel: string,
  recentTiers: Tier[],
  client?: CopilotClient,
): Promise<RouteResult> {
  const config = getRouterConfig();

  // Router disabled → manual mode
  if (!config.enabled) {
    messagesSinceSwitch = 0;
    return { model: currentModel, tier: null, switched: false, routerMode: "manual" };
  }

  const text = sanitize(prompt);

  // 1. Check overrides first — they bypass cooldown
  for (const rule of config.overrides) {
    if (rule.keywords.some((kw) => wordMatch(text, kw))) {
      const switched = rule.model !== currentModel;
      if (switched) messagesSinceSwitch = 0;
      return { model: rule.model, tier: null, overrideName: rule.name, switched, routerMode: "auto" };
    }
  }

  // 2. Classify the message
  const tier = await classifyMessage(prompt, recentTiers, client);
  const targetModel = config.tierModels[tier];
  const wouldSwitch = targetModel !== currentModel;

  // 3. Cooldown — prevent rapid switching
  if (wouldSwitch && messagesSinceSwitch < config.cooldownMessages) {
    messagesSinceSwitch++;
    return { model: currentModel, tier, switched: false, routerMode: "auto" };
  }

  if (wouldSwitch) messagesSinceSwitch = 0;
  else messagesSinceSwitch++;

  return { model: targetModel, tier, switched: wouldSwitch, routerMode: "auto" };
}
