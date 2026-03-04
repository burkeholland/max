import type { CopilotClient, CopilotSession } from "@github/copilot-sdk";
import { config } from "../config.js";

const CLASSIFIER_MODEL = "gpt-4.1";
const CLASSIFICATION_TIMEOUT_MS = 10_000;

const CLASSIFICATION_PROMPT = `Classify this request's complexity. Reply with exactly one word: SIMPLE, MEDIUM, or COMPLEX.

SIMPLE: greetings, factual lookups, yes/no questions, status checks, small talk, one-line answers
MEDIUM: explanations, summaries, code review, moderate analysis, single-file edits
COMPLEX: multi-step coding, architecture, debugging, research, creative writing, multi-file changes

Request: `;

let classifierSession: CopilotSession | undefined;
let classifierCreatePromise: Promise<CopilotSession> | undefined;

async function ensureClassifierSession(client: CopilotClient): Promise<CopilotSession> {
  if (classifierSession) return classifierSession;
  if (classifierCreatePromise) return classifierCreatePromise;

  classifierCreatePromise = (async () => {
    console.log(`[max] Creating eco mode classifier session (${CLASSIFIER_MODEL})`);
    const session = await client.createSession({
      model: CLASSIFIER_MODEL,
      streaming: false,
      systemMessage: {
        content: "You are a request classifier. Reply with exactly one word: SIMPLE, MEDIUM, or COMPLEX. Nothing else.",
      },
    });
    console.log(`[max] Classifier session ready`);
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
 * Classify a user prompt and return the model ID to use.
 * Returns the current model on any failure (no disruption).
 */
export async function classifyAndRoute(
  client: CopilotClient,
  prompt: string,
): Promise<{ model: string; tier: string }> {
  try {
    const session = await ensureClassifierSession(client);
    const result = await session.sendAndWait(
      { prompt: `${CLASSIFICATION_PROMPT}${prompt}` },
      CLASSIFICATION_TIMEOUT_MS,
    );

    const responseText = result?.data?.content || "";
    const tier = parseClassification(responseText);
    const model = config.ecoTiers[tier];

    console.log(`[max] Eco classifier: "${tier}" → ${model}`);
    return { model, tier };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[max] Eco classifier failed (using current model): ${msg}`);

    // Reset classifier session on error so it gets recreated next time
    if (/closed|destroy|disposed|invalid|expired|not found/i.test(msg)) {
      classifierSession = undefined;
    }

    return { model: config.copilotModel, tier: "fallback" };
  }
}

/** Tear down the classifier session (e.g., on client reset). */
export function resetClassifier(): void {
  classifierSession = undefined;
  classifierCreatePromise = undefined;
}
