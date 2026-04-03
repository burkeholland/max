import { approveAll, type CopilotClient, type CopilotSession } from "@github/copilot-sdk";
import { addMemory, updateMemory, searchMemories, addSummary, type MemoryCategory } from "../store/db.js";

// ---------------------------------------------------------------------------
// LLM-powered memory extraction — dedicated gpt-4.1 session
// ---------------------------------------------------------------------------

const EXTRACTOR_MODEL = "gpt-4.1";
const EXTRACT_TIMEOUT_MS = 15_000;
const SUMMARY_TIMEOUT_MS = 30_000;

const VALID_CATEGORIES: Set<string> = new Set([
  "preference", "fact", "project", "person", "routine", "task", "decision", "context",
]);

const EXTRACTION_SYSTEM_PROMPT = `You are a memory extraction engine for a personal AI assistant called Max. Your job is to analyze conversation turns and extract facts worth remembering long-term.

## Output Format
Respond with ONLY valid JSON — no markdown fences, no explanation. Return an object:
{
  "memories": [
    {
      "action": "add" | "update",
      "category": "preference" | "fact" | "project" | "person" | "routine" | "task" | "decision" | "context",
      "content": "concise statement of the fact",
      "importance": 1-5,
      "context": "one sentence: why this is worth remembering",
      "existing_id": null | number
    }
  ]
}

## Categories
- preference: User likes/dislikes, settings, working style
- fact: Identity, general knowledge, location, employer
- project: Codebase info, repos, tech stack, architecture
- person: People the user mentions — names, roles, relationships
- routine: Schedules, habits, recurring tasks
- task: Active tasks, goals, things the user is working on
- decision: Decisions made during conversation (technical or otherwise)
- context: Situational context about what's happening right now

## Importance Scale
- 5: Core identity, critical preferences, key project info (e.g., "I work at GitHub", "My main project is Max")
- 4: Important recurring facts (e.g., "I use TypeScript for everything", "Alice is my manager")
- 3: Useful context (e.g., "Working on authentication this week")
- 2: Minor preferences or transient details
- 1: Ephemeral, probably won't matter next session

## Rules
- Be CONSERVATIVE. Only extract facts that would be useful in a future conversation.
- Do NOT extract: greetings, acknowledgments, conversation mechanics, questions without answers, task instructions to the assistant.
- If the user corrects a previous fact, use "action": "update" with the existing_id.
- If nothing is worth remembering, return {"memories": []}.
- Keep content concise — max 150 characters per memory.
- One fact per memory entry. Don't combine multiple facts.`;

const SUMMARY_SYSTEM_PROMPT = `You are a conversation summarizer for a personal AI assistant called Max. Summarize the key points of a conversation segment in 3-6 bullet points.

Focus on:
- What the user asked for and what was accomplished
- Decisions made
- Important context or preferences expressed
- Ongoing tasks or commitments

Keep it concise — this summary is used for context recovery after session restarts. Max 300 words.
Respond with ONLY the summary text — no JSON, no markdown fences.`;

let extractorSession: CopilotSession | undefined;
let summarySession: CopilotSession | undefined;
let extractorClient: CopilotClient | undefined;
let summaryClient: CopilotClient | undefined;

async function ensureExtractorSession(client: CopilotClient): Promise<CopilotSession> {
  if (extractorSession && extractorClient === client) return extractorSession;

  if (extractorSession) {
    extractorSession.destroy().catch(() => {});
    extractorSession = undefined;
  }

  extractorSession = await client.createSession({
    model: EXTRACTOR_MODEL,
    streaming: false,
    systemMessage: { content: EXTRACTION_SYSTEM_PROMPT },
    onPermissionRequest: approveAll,
  });
  extractorClient = client;
  return extractorSession;
}

async function ensureSummarySession(client: CopilotClient): Promise<CopilotSession> {
  if (summarySession && summaryClient === client) return summarySession;

  if (summarySession) {
    summarySession.destroy().catch(() => {});
    summarySession = undefined;
  }

  summarySession = await client.createSession({
    model: EXTRACTOR_MODEL,
    streaming: false,
    systemMessage: { content: SUMMARY_SYSTEM_PROMPT },
    onPermissionRequest: approveAll,
  });
  summaryClient = client;
  return summarySession;
}

interface ExtractedMemoryAction {
  action: "add" | "update";
  category: string;
  content: string;
  importance: number;
  context?: string;
  existing_id?: number | null;
}

/**
 * Extract memories from a user+assistant conversation turn using LLM.
 * Returns the number of memories added/updated.
 */
export async function extractMemoriesWithLLM(
  client: CopilotClient,
  userMessage: string,
  assistantResponse: string,
): Promise<number> {
  try {
    // Get existing relevant memories for comparison
    const cleanMsg = userMessage.replace(/^\[via (?:telegram|tui)\]\s*/i, "").trim();
    const existing = searchMemories(undefined, undefined, 30);
    const existingBlock = existing.length > 0
      ? `\n\nExisting memories (for dedup/update):\n${existing.map((m) => `#${m.id} [${m.category}] ${m.content}`).join("\n")}`
      : "";

    const session = await ensureExtractorSession(client);
    const prompt = `User message: ${cleanMsg}\n\nAssistant response: ${assistantResponse.slice(0, 2000)}${existingBlock}`;
    const result = await session.sendAndWait({ prompt }, EXTRACT_TIMEOUT_MS);

    const raw = result?.data?.content || "";
    // Parse JSON — strip markdown fences if present
    const jsonStr = raw.replace(/^```(?:json)?\s*/, "").replace(/\s*```$/, "").trim();
    const parsed = JSON.parse(jsonStr) as { memories: ExtractedMemoryAction[] };

    if (!Array.isArray(parsed.memories)) return 0;

    let count = 0;
    for (const mem of parsed.memories) {
      if (!mem.content || mem.content.length < 3 || mem.content.length > 200) continue;
      if (!VALID_CATEGORIES.has(mem.category)) continue;

      const category = mem.category as MemoryCategory;
      const importance = Math.max(1, Math.min(5, mem.importance || 3));

      if (mem.action === "update" && mem.existing_id) {
        if (updateMemory(mem.existing_id, { content: mem.content, importance, context: mem.context })) {
          count++;
        }
      } else {
        addMemory(category, mem.content, "auto", importance, mem.context);
        count++;
      }
    }

    return count;
  } catch (err) {
    console.log(`[max] LLM memory extraction failed (non-fatal): ${err instanceof Error ? err.message : err}`);
    // Destroy broken session
    if (extractorSession) {
      extractorSession.destroy().catch(() => {});
      extractorSession = undefined;
    }
    return 0;
  }
}

/**
 * Generate a conversation summary from recent turns.
 * Returns the summary text, or empty string on failure.
 */
export async function generateConversationSummary(
  client: CopilotClient,
  turns: { id: number; role: string; content: string; source: string; ts: string }[],
): Promise<string> {
  if (turns.length === 0) return "";

  try {
    const session = await ensureSummarySession(client);

    const formatted = turns.map((t) => {
      const tag = t.role === "user" ? `[${t.source}] User` : t.role === "system" ? `[${t.source}] System` : "Max";
      const content = t.content.length > 1000 ? t.content.slice(0, 1000) + "…" : t.content;
      return `${tag}: ${content}`;
    }).join("\n\n");

    const result = await session.sendAndWait(
      { prompt: `Summarize this conversation segment:\n\n${formatted}` },
      SUMMARY_TIMEOUT_MS,
    );

    const summary = (result?.data?.content || "").trim();
    if (summary.length < 10) return "";

    // Store the summary
    const firstTs = turns[0]?.ts;
    const lastTs = turns[turns.length - 1]?.ts;
    addSummary(summary, turns.length, firstTs, lastTs);

    return summary;
  } catch (err) {
    console.log(`[max] Summary generation failed (non-fatal): ${err instanceof Error ? err.message : err}`);
    if (summarySession) {
      summarySession.destroy().catch(() => {});
      summarySession = undefined;
    }
    return "";
  }
}

/** Tear down extractor sessions (e.g. on shutdown). */
export function stopMemoryLLM(): void {
  if (extractorSession) {
    extractorSession.destroy().catch(() => {});
    extractorSession = undefined;
  }
  if (summarySession) {
    summarySession.destroy().catch(() => {});
    summarySession = undefined;
  }
  extractorClient = undefined;
  summaryClient = undefined;
}
