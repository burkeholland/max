// ---------------------------------------------------------------------------
// Episode writer — deterministic conversation summary backstop
// Generates daily wiki pages from conversation_log entries.
// Runs asynchronously after responses — never blocks the user.
// ---------------------------------------------------------------------------

import { approveAll, type CopilotClient, type CopilotSession } from "@github/copilot-sdk";
import { getDb, getState, setState } from "../store/db.js";
import { ensureWikiStructure, readPage, writePage } from "../wiki/fs.js";
import { addToIndex } from "../wiki/index-manager.js";
import { appendLog } from "../wiki/log-manager.js";

const EPISODE_MODEL = "gpt-4.1";
const EPISODE_TIMEOUT_MS = 30_000;
const MIN_TURNS_FOR_SUMMARY = 10;
const MIN_MINUTES_BETWEEN_SUMMARIES = 30;
const LAST_SUMMARIZED_KEY = "last_episode_log_id";
const LAST_SUMMARY_TIME_KEY = "last_episode_time";

const SYSTEM_PROMPT = `You are a conversation summarizer for an AI assistant called Max. You receive conversation log entries and produce a concise, structured summary.

Output format — markdown with YAML frontmatter:
- Title: "Conversations on YYYY-MM-DD"
- Key topics discussed (as bullet points)
- Decisions made
- Action items or follow-ups
- Cross-references to relevant wiki pages using [[Page Title]] links

Be concise but capture all important information. Include names, specifics, and context — not vague summaries. Write in third person ("Burke asked about...", "Max suggested...").`;

let episodeSession: CopilotSession | undefined;
let episodeClient: CopilotClient | undefined;

async function ensureSession(client: CopilotClient): Promise<CopilotSession> {
  if (episodeSession && episodeClient === client) {
    return episodeSession;
  }
  if (episodeSession) {
    episodeSession.destroy().catch(() => {});
    episodeSession = undefined;
  }
  episodeSession = await client.createSession({
    model: EPISODE_MODEL,
    streaming: false,
    systemMessage: { content: SYSTEM_PROMPT },
    onPermissionRequest: approveAll,
  });
  episodeClient = client;
  return episodeSession;
}

interface LogRow {
  id: number;
  role: string;
  content: string;
  source: string;
  ts: string;
}

/**
 * Check if a conversation summary is due, and if so, generate one.
 * Call this after delivering a response — it runs asynchronously.
 */
export async function maybeWriteEpisode(client: CopilotClient): Promise<void> {
  try {
    const db = getDb();
    const lastId = parseInt(getState(LAST_SUMMARIZED_KEY) || "0", 10);
    const lastTime = parseInt(getState(LAST_SUMMARY_TIME_KEY) || "0", 10);
    const now = Date.now();

    // Check time gate
    if (now - lastTime < MIN_MINUTES_BETWEEN_SUMMARIES * 60 * 1000) return;

    // Get unsummarized turns
    const rows = db.prepare(
      `SELECT id, role, content, source, ts FROM conversation_log WHERE id > ? ORDER BY id ASC`
    ).all(lastId) as LogRow[];

    if (rows.length < MIN_TURNS_FOR_SUMMARY) return;

    // Format conversation for summarization
    const transcript = rows.map((r) => {
      const tag = r.role === "user" ? `[${r.source}] User` : r.role === "system" ? `[system]` : "Max";
      const content = r.content.length > 500 ? r.content.slice(0, 500) + "…" : r.content;
      return `${tag} (${r.ts}): ${content}`;
    }).join("\n");

    const session = await ensureSession(client);
    const result = await session.sendAndWait(
      { prompt: `Summarize this conversation:\n\n${transcript}` },
      EPISODE_TIMEOUT_MS,
    );

    const summary = result?.data?.content || "";
    if (!summary || summary.length < 50) return;

    // Write to daily conversation page
    ensureWikiStructure();
    const today = new Date().toISOString().slice(0, 10);
    const pagePath = `pages/conversations/${today}.md`;
    const existing = readPage(pagePath);

    if (existing) {
      // Append to existing daily page
      const updated = existing.replace(
        /^(---[\s\S]*?updated:\s*)[\d-]+/m,
        `$1${today}`
      );
      writePage(pagePath, updated.trimEnd() + `\n\n---\n\n${summary}\n`);
    } else {
      const page = [
        "---",
        `title: Conversations on ${today}`,
        `tags: [conversation, episode]`,
        `created: ${today}`,
        `updated: ${today}`,
        "related: []",
        "---",
        "",
        `# Conversations on ${today}`,
        "",
        summary,
        "",
      ].join("\n");
      writePage(pagePath, page);
    }

    addToIndex({
      path: pagePath,
      title: `Conversations on ${today}`,
      summary: `Daily conversation summary for ${today}`,
      section: "Conversations",
      tags: ["conversation", "episode"],
      updated: today,
    });
    appendLog("update", `episode-writer: summarized ${rows.length} turns → ${pagePath}`);

    // Update state
    const maxId = rows[rows.length - 1].id;
    setState(LAST_SUMMARIZED_KEY, String(maxId));
    setState(LAST_SUMMARY_TIME_KEY, String(now));

    console.log(`[max] Episode writer: summarized ${rows.length} turns → ${pagePath}`);
  } catch (err) {
    console.log(`[max] Episode writer error (non-fatal): ${err instanceof Error ? err.message : err}`);
    if (episodeSession) {
      episodeSession.destroy().catch(() => {});
      episodeSession = undefined;
    }
  }
}

/** Tear down the episode writer session. */
export function stopEpisodeWriter(): void {
  if (episodeSession) {
    episodeSession.destroy().catch(() => {});
    episodeSession = undefined;
    episodeClient = undefined;
  }
}
