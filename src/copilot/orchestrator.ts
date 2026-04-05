import { approveAll, type CopilotClient, type CopilotSession } from "@github/copilot-sdk";
import { createTools, createAgentTools, type WorkerInfo } from "./tools.js";
import { getOrchestratorSystemMessage } from "./system-message.js";
import { config, DEFAULT_MODEL } from "../config.js";
import { loadMcpConfig } from "./mcp-config.js";
import { getSkillDirectories } from "./skills.js";
import { resetClient } from "./client.js";
import { logConversation, getState, setState, deleteState, getRecentConversation, runMemoryMaintenance } from "../store/db.js";
import { SESSIONS_DIR } from "../paths.js";
import { resolveModel, type Tier, type RouteResult } from "./router.js";
import { getRelevantWikiContext, getWikiSummary } from "../wiki/context.js";
import { loadAgents, getAgent, ensureDefaultAgents, getAgentRoster, agentRecall, type AgentDefinition } from "./agents.js";

const MAX_RETRIES = 3;
const RECONNECT_DELAYS_MS = [1_000, 3_000, 10_000];
const HEALTH_CHECK_INTERVAL_MS = 30_000;

const ORCHESTRATOR_SESSION_KEY = "orchestrator_session_id";

export type MessageSource =
  | { type: "telegram"; chatId: number; messageId: number }
  | { type: "tui"; connectionId: string }
  | { type: "background" };

export type MessageCallback = (text: string, done: boolean) => void;

type LogFn = (direction: "in" | "out", source: string, text: string) => void;
let logMessage: LogFn = () => {};

export function setMessageLogger(fn: LogFn): void {
  logMessage = fn;
}

// Proactive notification — sends unsolicited messages to the user on a specific channel
type ProactiveNotifyFn = (text: string, channel?: "telegram" | "tui") => void;
let proactiveNotifyFn: ProactiveNotifyFn | undefined;

export function setProactiveNotify(fn: ProactiveNotifyFn): void {
  proactiveNotifyFn = fn;
}

let copilotClient: CopilotClient | undefined;
const workers = new Map<string, WorkerInfo>();
let healthCheckTimer: ReturnType<typeof setInterval> | undefined;

// Router state — tracks model across the session
let currentSessionModel: string | undefined;
let recentTiers: Tier[] = [];
let lastRouteResult: RouteResult | undefined;

export function getLastRouteResult(): RouteResult | undefined {
  return lastRouteResult;
}

// ---------------------------------------------------------------------------
// Agent state
// ---------------------------------------------------------------------------

/** Persistent sessions per agent (keyed by slug). */
const agentSessions = new Map<string, CopilotSession>();

/** Sticky routing: which agent is active per channel. null = orchestrator. */
const activeAgentByChannel = new Map<string, string>();

/** Get which agent is active for a channel (or null for orchestrator). */
export function getActiveAgent(channel: string): string | null {
  return activeAgentByChannel.get(channel) ?? null;
}

/** Set the active agent for a channel. */
export function setActiveAgent(channel: string, agentSlug: string | null): void {
  if (agentSlug) {
    activeAgentByChannel.set(channel, agentSlug);
  } else {
    activeAgentByChannel.delete(channel);
  }
}

// Persistent orchestrator session
let orchestratorSession: CopilotSession | undefined;
// Coalesces concurrent ensureOrchestratorSession calls
let sessionCreatePromise: Promise<CopilotSession> | undefined;

// Message queue — serializes access to the single persistent session
type QueuedMessage = {
  prompt: string;
  attachments?: Array<{ type: "file"; path: string; displayName?: string }>;
  callback: MessageCallback;
  sourceChannel?: "telegram" | "tui";
  resolve: (value: string) => void;
  reject: (err: unknown) => void;
};
const messageQueue: QueuedMessage[] = [];
let processing = false;
let currentCallback: MessageCallback | undefined;
/** The session currently executing a request (orchestrator or agent). */
let currentActiveSession: CopilotSession | undefined;
/** The channel currently being processed — tools use this to tag new workers. */
let currentSourceChannel: "telegram" | "tui" | undefined;

/** Get the channel that originated the message currently being processed. */
export function getCurrentSourceChannel(): "telegram" | "tui" | undefined {
  return currentSourceChannel;
}

function getSessionConfig() {
  const tools = createTools({
    client: copilotClient!,
    workers,
    onWorkerComplete: feedBackgroundResult,
  });
  const mcpServers = loadMcpConfig();
  const skillDirectories = getSkillDirectories();
  return { tools, mcpServers, skillDirectories };
}

/** Feed a background worker result into the orchestrator as a new turn. */
export function feedBackgroundResult(workerName: string, result: string): void {
  const worker = workers.get(workerName);
  const channel = worker?.originChannel;
  const prompt = `[Background task completed] Worker '${workerName}' finished:\n\n${result}`;
  sendToOrchestrator(
    prompt,
    { type: "background" },
    (_text, done) => {
      if (done && proactiveNotifyFn) {
        proactiveNotifyFn(_text, channel);
      }
    }
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Ensure the SDK client is connected, resetting if necessary. Coalesces concurrent resets. */
let resetPromise: Promise<CopilotClient> | undefined;
async function ensureClient(): Promise<CopilotClient> {
  if (copilotClient && copilotClient.getState() === "connected") {
    return copilotClient;
  }
  if (!resetPromise) {
    console.log(`[max] Client not connected (state: ${copilotClient?.getState() ?? "null"}), resetting…`);
    resetPromise = resetClient().then((c) => {
      console.log(`[max] Client reset successful, state: ${c.getState()}`);
      copilotClient = c;
      return c;
    }).finally(() => { resetPromise = undefined; });
  }
  return resetPromise;
}

/** Start periodic health check that proactively reconnects the client. */
function startHealthCheck(): void {
  if (healthCheckTimer) return;
  healthCheckTimer = setInterval(async () => {
    if (!copilotClient) return;
    try {
      const state = copilotClient.getState();
      if (state !== "connected") {
        console.log(`[max] Health check: client state is '${state}', resetting…`);
        await ensureClient();
        // Session may need recovery after client reset
        orchestratorSession = undefined;
        currentSessionModel = undefined;
      }
    } catch (err) {
      console.error(`[max] Health check error:`, err instanceof Error ? err.message : err);
    }
  }, HEALTH_CHECK_INTERVAL_MS);
}

/** Create or resume the persistent orchestrator session. */
async function ensureOrchestratorSession(): Promise<CopilotSession> {
  if (orchestratorSession) return orchestratorSession;
  // Coalesce concurrent callers — wait for an in-flight creation
  if (sessionCreatePromise) return sessionCreatePromise;

  sessionCreatePromise = createOrResumeSession();
  try {
    const session = await sessionCreatePromise;
    orchestratorSession = session;
    return session;
  } finally {
    sessionCreatePromise = undefined;
  }
}

/** Internal: actually create or resume a session (not concurrency-safe — use ensureOrchestratorSession). */
async function createOrResumeSession(): Promise<CopilotSession> {
  const client = await ensureClient();
  const { tools, mcpServers, skillDirectories } = getSessionConfig();
  const wikiSummary = getWikiSummary();
  const agentRoster = getAgentRoster();

  const systemMessageOpts = {
    selfEditEnabled: config.selfEditEnabled,
    agentRoster: agentRoster || undefined,
  };

  const infiniteSessions = {
    enabled: true,
    backgroundCompactionThreshold: 0.80,
    bufferExhaustionThreshold: 0.95,
  };

  // Try to resume a previous session
  const savedSessionId = getState(ORCHESTRATOR_SESSION_KEY);
  if (savedSessionId) {
    try {
      console.log(`[max] Resuming orchestrator session ${savedSessionId.slice(0, 8)}…`);
      const session = await client.resumeSession(savedSessionId, {
        model: config.copilotModel,
        configDir: SESSIONS_DIR,
        streaming: true,
        systemMessage: {
          content: getOrchestratorSystemMessage(wikiSummary || undefined, systemMessageOpts),
        },
        tools,
        mcpServers,
        skillDirectories,
        onPermissionRequest: approveAll,
        infiniteSessions,
      });
      console.log(`[max] Resumed orchestrator session successfully`);
      currentSessionModel = config.copilotModel;
      return session;
    } catch (err) {
      console.log(`[max] Could not resume session: ${err instanceof Error ? err.message : err}. Creating new.`);
      deleteState(ORCHESTRATOR_SESSION_KEY);
    }
  }

  // Create a fresh session
  console.log(`[max] Creating new persistent orchestrator session`);
  const session = await client.createSession({
    model: config.copilotModel,
    configDir: SESSIONS_DIR,
    streaming: true,
    systemMessage: {
      content: getOrchestratorSystemMessage(wikiSummary || undefined, systemMessageOpts),
    },
    tools,
    mcpServers,
    skillDirectories,
    onPermissionRequest: approveAll,
    infiniteSessions,
  });

  // Persist the session ID for future restarts
  setState(ORCHESTRATOR_SESSION_KEY, session.sessionId);
  console.log(`[max] Created orchestrator session ${session.sessionId.slice(0, 8)}…`);

  // Recover conversation context if available (session was lost, not first run)
  const recentHistory = getRecentConversation(30);
  const recoveryWikiSummary = getWikiSummary();
  if (recentHistory || recoveryWikiSummary) {
    console.log(`[max] Injecting recovery context into new session (${recentHistory ? "conversation + " : ""}${recoveryWikiSummary ? "wiki" : ""})`);
    const parts: string[] = [
      "[System: Session recovered] Your previous session was lost. Absorb this context silently — do NOT respond to it.",
    ];
    if (recoveryWikiSummary) {
      parts.push(`\n## Your Wiki Knowledge Base:\n${recoveryWikiSummary}`);
    }
    if (recentHistory) {
      parts.push(`\n## Recent Conversation (last 30 turns):\n${recentHistory}`);
    }
    parts.push("\n(End of recovery context. Wait for the next real message.)");
    try {
      await session.sendAndWait({ prompt: parts.join("\n") }, 60_000);
    } catch (err) {
      console.log(`[max] Context recovery injection failed (non-fatal): ${err instanceof Error ? err.message : err}`);
    }
  }

  currentSessionModel = config.copilotModel;
  return session;
}

export async function initOrchestrator(client: CopilotClient): Promise<void> {
  copilotClient = client;
  const { mcpServers, skillDirectories } = getSessionConfig();

  // Validate configured model against available models
  try {
    const models = await client.listModels();
    const configured = config.copilotModel;
    const isAvailable = models.some((m) => m.id === configured);
    if (!isAvailable) {
      console.log(`[max] ⚠️ Configured model '${configured}' is not available. Falling back to '${DEFAULT_MODEL}'.`);
      config.copilotModel = DEFAULT_MODEL;
    }
  } catch (err) {
    console.log(`[max] Could not validate model (will use '${config.copilotModel}' as-is): ${err instanceof Error ? err.message : err}`);
  }

  console.log(`[max] Loading ${Object.keys(mcpServers).length} MCP server(s): ${Object.keys(mcpServers).join(", ") || "(none)"}`);
  console.log(`[max] Skill directories: ${skillDirectories.join(", ") || "(none)"}`);
  console.log(`[max] Persistent session mode — conversation history maintained by SDK`);
  startHealthCheck();

  // Initialize agent system
  ensureDefaultAgents();
  const agents = loadAgents();
  console.log(`[max] Loaded ${agents.length} agent(s): ${agents.map((a) => `@${a.slug}`).join(", ") || "(none)"}`);

  // Run memory maintenance on startup (best-effort)
  try {
    const { deduped, pruned, capped } = runMemoryMaintenance();
    if (deduped + pruned + capped > 0) {
      console.log(`[max] Memory maintenance: ${deduped} deduped, ${pruned} stale pruned, ${capped} capped`);
    }
  } catch (err) {
    console.log(`[max] Memory maintenance failed (non-fatal): ${err instanceof Error ? err.message : err}`);
  }

  // Eagerly create/resume the orchestrator session
  try {
    await ensureOrchestratorSession();
  } catch (err) {
    console.error(`[max] Failed to create initial session (will retry on first message):`, err instanceof Error ? err.message : err);
  }
}

// ---------------------------------------------------------------------------
// Agent session management
// ---------------------------------------------------------------------------

const AGENT_SESSION_PREFIX = "agent_session_";

/** Create or resume a persistent session for a named agent. */
async function ensureAgentSession(agentDef: AgentDefinition): Promise<CopilotSession> {
  const existing = agentSessions.get(agentDef.slug);
  if (existing) return existing;

  const client = await ensureClient();

  // Inject agent's wiki notes for context
  const agentNotes = agentRecall(agentDef.slug);
  const notesBlock = agentNotes !== "No notes yet."
    ? `\n\n## Your Notes\n${agentNotes}`
    : "";

  const agentTools = createAgentTools({
    agentSlug: agentDef.slug,
    client,
  });

  // Try to resume a saved agent session
  const savedId = getState(AGENT_SESSION_PREFIX + agentDef.slug);
  if (savedId) {
    try {
      console.log(`[max] Resuming @${agentDef.slug} session ${savedId.slice(0, 8)}…`);
      const session = await client.resumeSession(savedId, {
        model: agentDef.model || config.copilotModel,
        configDir: SESSIONS_DIR,
        streaming: true,
        systemMessage: { content: agentDef.systemMessage + notesBlock },
        tools: agentTools,
        onPermissionRequest: approveAll,
        infiniteSessions: {
          enabled: true,
          backgroundCompactionThreshold: 0.80,
          bufferExhaustionThreshold: 0.95,
        },
      });
      agentSessions.set(agentDef.slug, session);
      console.log(`[max] Resumed @${agentDef.slug} session`);
      return session;
    } catch (err) {
      console.log(`[max] Could not resume @${agentDef.slug} session: ${err instanceof Error ? err.message : err}. Creating new.`);
      deleteState(AGENT_SESSION_PREFIX + agentDef.slug);
    }
  }

  // Create a fresh session
  console.log(`[max] Creating new session for @${agentDef.slug}`);
  const session = await client.createSession({
    model: agentDef.model || config.copilotModel,
    configDir: SESSIONS_DIR,
    streaming: true,
    systemMessage: { content: agentDef.systemMessage + notesBlock },
    tools: agentTools,
    onPermissionRequest: approveAll,
    infiniteSessions: {
      enabled: true,
      backgroundCompactionThreshold: 0.80,
      bufferExhaustionThreshold: 0.95,
    },
  });

  setState(AGENT_SESSION_PREFIX + agentDef.slug, session.sessionId);
  agentSessions.set(agentDef.slug, session);
  console.log(`[max] Created @${agentDef.slug} session ${session.sessionId.slice(0, 8)}…`);
  return session;
}

/** Send a prompt to an agent's persistent session. */
async function executeOnAgentSession(
  agentDef: AgentDefinition,
  prompt: string,
  callback: MessageCallback,
): Promise<string> {
  const session = await ensureAgentSession(agentDef);
  currentCallback = callback;
  currentActiveSession = session;

  let accumulated = "";
  let toolCallExecuted = false;
  const unsubToolDone = session.on("tool.execution_complete", () => {
    toolCallExecuted = true;
  });
  const unsubDelta = session.on("assistant.message_delta", (event) => {
    if (toolCallExecuted && accumulated.length > 0 && !accumulated.endsWith("\n")) {
      accumulated += "\n";
    }
    toolCallExecuted = false;
    accumulated += event.data.deltaContent;
    callback(accumulated, false);
  });

  try {
    const result = await session.sendAndWait(
      { prompt },
      300_000,
    );
    const finalContent = result?.data?.content || accumulated || "(No response)";
    return finalContent;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (/closed|destroy|disposed|invalid|expired|not found/i.test(msg)) {
      console.log(`[max] @${agentDef.slug} session appears dead, will recreate: ${msg}`);
      agentSessions.delete(agentDef.slug);
      deleteState(AGENT_SESSION_PREFIX + agentDef.slug);
    }
    throw err;
  } finally {
    unsubDelta();
    unsubToolDone();
    currentCallback = undefined;
    currentActiveSession = undefined;
  }
}

/** Destroy an agent's persistent session (e.g., when firing an agent). */
export function destroyAgentSession(slug: string): void {
  const session = agentSessions.get(slug);
  if (session) {
    session.destroy().catch(() => {});
    agentSessions.delete(slug);
    deleteState(AGENT_SESSION_PREFIX + slug);
  }
}

// ---------------------------------------------------------------------------
// @mention parsing
// ---------------------------------------------------------------------------

/** Parse an @mention at the start of a message. Returns { agent, rest } or null. */
function parseAtMention(prompt: string): { agent: string; rest: string } | null {
  const match = prompt.match(/^@(\w[\w-]*)\s*([\s\S]*)/);
  if (!match) return null;
  return { agent: match[1].toLowerCase(), rest: match[2].trim() };
}

/** Send a prompt on the persistent session, return the response. */
async function executeOnSession(
  prompt: string,
  callback: MessageCallback,
  attachments?: Array<{ type: "file"; path: string; displayName?: string }>
): Promise<string> {
  const session = await ensureOrchestratorSession();
  currentCallback = callback;
  currentActiveSession = session;

  // Inject relevant wiki context into the prompt (skip for background task results)
  let enrichedPrompt = prompt;
  if (!prompt.startsWith("[Background task completed]")) {
    try {
      const wikiContext = getRelevantWikiContext(prompt, 3);
      if (wikiContext) {
        // Cap at 1500 chars to balance context richness vs prompt bloat
        const trimmed = wikiContext.length > 1500 ? wikiContext.slice(0, 1500) + "…" : wikiContext;
        enrichedPrompt = `[Wiki context:\n${trimmed}\n]\n\n${prompt}`;
      }
    } catch { /* non-fatal */ }
  }

  let accumulated = "";
  let toolCallExecuted = false;
  const unsubToolDone = session.on("tool.execution_complete", () => {
    toolCallExecuted = true;
  });
  const unsubDelta = session.on("assistant.message_delta", (event) => {
    // After a tool call completes, ensure a line break separates the text blocks
    // so they don't visually run together in the TUI.
    if (toolCallExecuted && accumulated.length > 0 && !accumulated.endsWith("\n")) {
      accumulated += "\n";
    }
    toolCallExecuted = false;
    accumulated += event.data.deltaContent;
    callback(accumulated, false);
  });

  try {
    const result = await session.sendAndWait(
      { prompt: enrichedPrompt, ...(attachments && attachments.length > 0 ? { attachments } : {}) },
      300_000
    );
    const finalContent = result?.data?.content || accumulated || "(No response)";
    return finalContent;
  } catch (err) {
    // If the session is broken, invalidate it so it's recreated on next attempt
    const msg = err instanceof Error ? err.message : String(err);
    if (/closed|destroy|disposed|invalid|expired|not found/i.test(msg)) {
      console.log(`[max] Session appears dead, will recreate: ${msg}`);
      orchestratorSession = undefined;
      currentSessionModel = undefined;
      deleteState(ORCHESTRATOR_SESSION_KEY);
    }
    throw err;
  } finally {
    unsubDelta();
    unsubToolDone();
    currentCallback = undefined;
    currentActiveSession = undefined;
  }
}

/** Process the message queue one at a time. */
async function processQueue(): Promise<void> {
  if (processing) {
    if (messageQueue.length > 0) {
      console.log(`[max] Message queued (${messageQueue.length} waiting — orchestrator is busy)`);
    }
    return;
  }
  processing = true;

  while (messageQueue.length > 0) {
    const item = messageQueue.shift()!;
    currentSourceChannel = item.sourceChannel;
    try {
      // --- Agent routing: check for @mention or sticky agent ---
      const channelKey = item.sourceChannel || "default";
      const rawPrompt = item.prompt
        .replace(/^\[via \w+\]\s*/i, "")
        .trim();

      const mention = parseAtMention(rawPrompt);

      // @max → return to orchestrator
      if (mention && mention.agent === "max") {
        setActiveAgent(channelKey, null);
        const prompt = mention.rest || "I'm back. What's up?";
        // Tag it back for the orchestrator
        const taggedBack = item.sourceChannel ? `[via ${item.sourceChannel}] ${prompt}` : prompt;
        const routeResult = await resolveModel(taggedBack, currentSessionModel || config.copilotModel, recentTiers, copilotClient);
        if (routeResult.switched && orchestratorSession) {
          try {
            config.copilotModel = routeResult.model;
            await orchestratorSession.setModel(routeResult.model);
            currentSessionModel = routeResult.model;
          } catch { /* will apply next time */ }
        }
        lastRouteResult = { ...routeResult, activeAgent: null } as any;
        const result = await executeOnSession(taggedBack, item.callback, item.attachments);
        item.resolve(result);
        currentSourceChannel = undefined;
        continue;
      }

      // @agentname → switch to agent sticky session
      if (mention) {
        const agentDef = getAgent(mention.agent);
        if (agentDef) {
          setActiveAgent(channelKey, agentDef.slug);
          console.log(`[max] @${agentDef.slug} activated (sticky) for ${channelKey}`);
          const prompt = mention.rest || `Hello! I'm ready to help. What do you need?`;
          lastRouteResult = { model: agentDef.model || config.copilotModel, tier: null, switched: false, routerMode: "agent", activeAgent: agentDef.slug } as any;
          const result = await executeOnAgentSession(agentDef, prompt, item.callback);
          item.resolve(result);
          currentSourceChannel = undefined;
          continue;
        }
        // Agent not found — fall through to orchestrator, but let the user know
      }

      // Check for sticky agent on this channel
      const stickyAgent = getActiveAgent(channelKey);
      if (stickyAgent) {
        const agentDef = getAgent(stickyAgent);
        if (agentDef) {
          lastRouteResult = { model: agentDef.model || config.copilotModel, tier: null, switched: false, routerMode: "agent", activeAgent: agentDef.slug } as any;
          const result = await executeOnAgentSession(agentDef, rawPrompt, item.callback);
          item.resolve(result);
          currentSourceChannel = undefined;
          continue;
        }
        // Agent definition was removed — clear sticky
        setActiveAgent(channelKey, null);
      }

      // --- Normal orchestrator routing ---
      const routeResult = await resolveModel(item.prompt, currentSessionModel || config.copilotModel, recentTiers, copilotClient);
      if (routeResult.switched) {
        console.log(`[max] Auto: switching to ${routeResult.model} (${routeResult.overrideName || routeResult.tier})`);
        config.copilotModel = routeResult.model;
        if (orchestratorSession) {
          try {
            await orchestratorSession.setModel(routeResult.model);
            currentSessionModel = routeResult.model;
            console.log(`[max] Model switched in-place via setModel()`);
          } catch (err) {
            console.log(`[max] setModel() failed, will recreate session: ${err instanceof Error ? err.message : err}`);
            orchestratorSession = undefined;
            deleteState(ORCHESTRATOR_SESSION_KEY);
          }
        }
      }
      if (routeResult.tier) {
        recentTiers.push(routeResult.tier);
        if (recentTiers.length > 5) recentTiers = recentTiers.slice(-5);
      }
      lastRouteResult = { ...routeResult, activeAgent: null } as any;

      const result = await executeOnSession(item.prompt, item.callback, item.attachments);
      item.resolve(result);
    } catch (err) {
      item.reject(err);
    }
    currentSourceChannel = undefined;
  }

  processing = false;
}

function isRecoverableError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /timeout|disconnect|connection|EPIPE|ECONNRESET|ECONNREFUSED|socket|closed|ENOENT|spawn|not found|expired|stale/i.test(msg);
}

export async function sendToOrchestrator(
  prompt: string,
  source: MessageSource,
  callback: MessageCallback,
  attachments?: Array<{ type: "file"; path: string; displayName?: string }>
): Promise<void> {
  const sourceLabel =
    source.type === "telegram" ? "telegram" :
    source.type === "tui" ? "tui" : "background";
  logMessage("in", sourceLabel, prompt);

  // Tag the prompt with its source channel
  const taggedPrompt = source.type === "background"
    ? prompt
    : `[via ${sourceLabel}] ${prompt}`;

  // Log role: background events are "system", user messages are "user"
  const logRole = source.type === "background" ? "system" : "user";

  // Determine the source channel for worker origin tracking
  const sourceChannel: "telegram" | "tui" | undefined =
    source.type === "telegram" ? "telegram" :
    source.type === "tui" ? "tui" : undefined;

  // Enqueue and process
  void (async () => {
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      try {
        const finalContent = await new Promise<string>((resolve, reject) => {
          messageQueue.push({ prompt: taggedPrompt, attachments, callback, sourceChannel, resolve, reject });
          processQueue();
        });
        // Deliver response to user FIRST, then log best-effort
        callback(finalContent, true);
        try { logMessage("out", sourceLabel, finalContent); } catch { /* best-effort */ }
        // Log both sides of the conversation after delivery
        try { logConversation(logRole, prompt, sourceLabel); } catch { /* best-effort */ }
        try { logConversation("assistant", finalContent, sourceLabel); } catch { /* best-effort */ }
        return;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);

        // Don't retry cancelled messages
        if (/cancelled|abort/i.test(msg)) {
          return;
        }

        if (isRecoverableError(err) && attempt < MAX_RETRIES) {
          const delay = RECONNECT_DELAYS_MS[Math.min(attempt, RECONNECT_DELAYS_MS.length - 1)];
          console.error(`[max] Recoverable error: ${msg}. Retry ${attempt + 1}/${MAX_RETRIES} after ${delay}ms…`);
          await sleep(delay);
          // Reset client before retry in case the connection is stale
          try { await ensureClient(); } catch { /* will fail again on next attempt */ }
          continue;
        }

        console.error(`[max] Error processing message: ${msg}`);
        callback(`Error: ${msg}`, true);
        return;
      }
    }
  })();
}

/** Cancel the in-flight message and drain the queue. */
export async function cancelCurrentMessage(): Promise<boolean> {
  // Drain any queued messages
  const drained = messageQueue.length;
  while (messageQueue.length > 0) {
    const item = messageQueue.shift()!;
    item.reject(new Error("Cancelled"));
  }

  // Abort the active session request (orchestrator or agent)
  if (currentActiveSession && currentCallback) {
    try {
      await currentActiveSession.abort();
      console.log(`[max] Aborted in-flight request`);
      return true;
    } catch (err) {
      console.error(`[max] Abort failed:`, err instanceof Error ? err.message : err);
    }
  }

  return drained > 0;
}

/** Switch the model on the live orchestrator session without destroying it. */
export async function switchSessionModel(newModel: string): Promise<void> {
  if (orchestratorSession) {
    await orchestratorSession.setModel(newModel);
    currentSessionModel = newModel;
  }
}

export function getWorkers(): Map<string, WorkerInfo> {
  return workers;
}
