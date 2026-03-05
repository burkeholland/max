import type { CopilotClient, CopilotSession } from "@github/copilot-sdk";
import { config } from "../config.js";

const CLASSIFICATION_TIMEOUT_MS = 10_000;
const MODEL_CACHE_TTL_MS = 5 * 60_000; // refresh available models every 5 min

const CLASSIFICATION_PROMPT = `Classify this request's complexity. Reply with exactly one word: SIMPLE, MEDIUM, or COMPLEX.

SIMPLE: greetings, factual lookups, yes/no questions, status checks, small talk, one-line answers
MEDIUM: explanations, summaries, code review, moderate analysis, single-file edits
COMPLEX: multi-step coding, architecture, debugging, research, creative writing, multi-file changes

Request: `;

let classifierSession: CopilotSession | undefined;
let classifierSessionModel: string | undefined;
let classifierCreatePromise: Promise<CopilotSession> | undefined;

// Cached available model IDs
let cachedModelIds: Set<string> | undefined;
let cacheTimestamp = 0;

/** Refresh the available models cache if stale. */
async function getAvailableModels(client: CopilotClient): Promise<Set<string>> {
  if (cachedModelIds && Date.now() - cacheTimestamp < MODEL_CACHE_TTL_MS) {
    return cachedModelIds;
  }
  try {
    const models = await client.listModels();
    cachedModelIds = new Set(models.map((m) => m.id));
    cacheTimestamp = Date.now();
    console.log(`[max] Eco: cached ${cachedModelIds.size} available models`);
    return cachedModelIds;
  } catch (err) {
    console.error(`[max] Eco: failed to list models, using stale cache`);
    return cachedModelIds || new Set();
  }
}

/** Pick the cheapest available model for classification. */
async function pickClassifierModel(client: CopilotClient): Promise<string> {
  const available = await getAvailableModels(client);
  if (available.size === 0) {
    return config.copilotModel; // no model data — use whatever the user has configured
  }
  try {
    // We need billing info which the Set doesn't have — use the cached list call
    const models = await client.listModels();
    const sorted = [...models]
      .filter((m) => m.billing?.multiplier !== undefined)
      .sort((a, b) => (a.billing?.multiplier ?? 99) - (b.billing?.multiplier ?? 99));
    if (sorted.length > 0) return sorted[0].id;
    return models[0]?.id || config.copilotModel;
  } catch {
    return config.copilotModel;
  }
}

async function ensureClassifierSession(client: CopilotClient): Promise<CopilotSession> {
  const targetModel = await pickClassifierModel(client);

  // Recreate if model changed (e.g., new cheaper model became available)
  if (classifierSession && classifierSessionModel === targetModel) return classifierSession;
  if (classifierCreatePromise) return classifierCreatePromise;

  classifierCreatePromise = (async () => {
    console.log(`[max] Creating eco mode classifier session (${targetModel})`);
    const session = await client.createSession({
      model: targetModel,
      streaming: false,
      systemMessage: {
        content: "You are a request classifier. Reply with exactly one word: SIMPLE, MEDIUM, or COMPLEX. Nothing else.",
      },
    });
    classifierSessionModel = targetModel;
    console.log(`[max] Classifier session ready (${targetModel})`);
    return session;
  })();

  try {
    classifierSession = await classifierCreatePromise;
    return classifierSession;
  } finally {
    classifierCreatePromise = undefined;
  }
}

function parseClassification(response: string): "simple" | "medium" | "complex" {
  const normalized = response.trim().toUpperCase();
  // Match the first standalone classification word
  const match = normalized.match(/\b(SIMPLE|MEDIUM|COMPLEX)\b/);
  if (match) {
    return match[1].toLowerCase() as "simple" | "medium" | "complex";
  }
  console.log(`[max] Eco classifier: could not parse "${response}", defaulting to MEDIUM`);
  return "medium";
}

/**
 * Resolve a tier model to an available model ID.
 * Returns the tier model if available, otherwise falls back to the current model.
 */
function resolveModel(tierModel: string, available: Set<string>, fallback: string): string {
  if (available.has(tierModel)) return tierModel;
  console.log(`[max] Eco: model "${tierModel}" not available, falling back to "${fallback}"`);
  return fallback;
}

/**
 * Classify a user prompt and return the model ID to use.
 * Validates the target model against available models.
 * Returns the current model on any failure (no disruption).
 */
export async function classifyAndRoute(
  client: CopilotClient,
  prompt: string,
): Promise<{ model: string; tier: string }> {
  try {
    const [session, available] = await Promise.all([
      ensureClassifierSession(client),
      getAvailableModels(client),
    ]);
    const result = await session.sendAndWait(
      { prompt: `${CLASSIFICATION_PROMPT}${prompt}` },
      CLASSIFICATION_TIMEOUT_MS,
    );

    const responseText = result?.data?.content || "";
    const tier = parseClassification(responseText);
    const tierModel = config.ecoTiers[tier];
    const model = resolveModel(tierModel, available, config.copilotModel);

    console.log(`[max] Eco classifier: "${tier}" → ${model}${model !== tierModel ? ` (wanted ${tierModel})` : ""}`);
    return { model, tier };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[max] Eco classifier failed (using current model): ${msg}`);

    // Reset classifier session on error so it gets recreated next time
    if (/closed|destroy|disposed|invalid|expired|not found/i.test(msg)) {
      classifierSession = undefined;
      classifierSessionModel = undefined;
    }

    return { model: config.copilotModel, tier: "fallback" };
  }
}

/** Tear down the classifier session (e.g., on client reset). */
export function resetClassifier(): void {
  classifierSession = undefined;
  classifierSessionModel = undefined;
  classifierCreatePromise = undefined;
  cachedModelIds = undefined;
  cacheTimestamp = 0;
}
