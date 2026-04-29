import { approveAll, type CopilotClient, type CopilotSession } from "@github/copilot-sdk";
import { createTools, type ToolDeps } from "./tools.js";
import { getOrchestratorSystemMessage } from "./system-message.js";
import { config, DEFAULT_MODEL } from "../config.js";
import { loadMcpConfig } from "./mcp-config.js";
import { getSkillDirectories } from "./skills.js";
import { resetClient } from "./client.js";
import { logConversation, getState, setState, deleteState } from "../store/db.js";
import { getWikiSummary } from "../wiki/context.js";
import { SESSIONS_DIR } from "../paths.js";
import { resolveModel, type Tier, type RouteResult } from "./router.js";
import {
  loadAgents, ensureDefaultAgents,
  clearActiveTasks, getAgentRegistry, getActiveAgent,
  setActiveAgent, parseAtMention, buildAgentRoster,
  getActiveTasks, completeTask, failTask,
} from "./agents.js";


/**
 * Permission handler for the orchestrator session.
 * Approves all tool requests so @max has full access to all tools.
 */
const orchestratorPermissionHandler = approveAll;

const MAX_RETRIES = 3;
const RECONNECT_DELAYS_MS = [1_000, 3_000, 10_000];
const HEALTH_CHECK_INTERVAL_MS = 30_000;

const ORCHESTRATOR_SESSION_KEY = "orchestrator_session_id";

export type SourceChannel = "telegram" | "tui" | "feishu";

export type MessageSource =
  | { type: "telegram"; chatId: number; messageId: number }
  | { type: "tui"; connectionId: string }
  | { type: "feishu"; chatId: string; messageId: string; openId: string }
  | { type: "background" };

export type MessageCallback = (text: string, done: boolean) => void;

type LogFn = (direction: "in" | "out", source: string, text: string) => void;
let logMessage: LogFn = () => {};

export function setMessageLogger(fn: LogFn): void {
  logMessage = fn;
}

// Proactive notification — sends unsolicited messages to the user on a specific destination.
type ProactiveNotifyFn = (text: string, destination?: string) => void;
let proactiveNotifyFn: ProactiveNotifyFn | undefined;

export function setProactiveNotify(fn: ProactiveNotifyFn): void {
  proactiveNotifyFn = fn;
}

let copilotClient: CopilotClient | undefined;
let healthCheckTimer: ReturnType<typeof setInterval> | undefined;

// Router state — tracks model across the session
let currentSessionModel: string | undefined;
let recentTiers: Tier[] = [];
let lastRouteResult: RouteResult | undefined;

export function getLastRouteResult(): RouteResult | undefined {
  return lastRouteResult;
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
  sourceChannel?: SourceChannel;
  /** Target agent slug for @mention routing. If undefined, goes to orchestrator. */
  targetAgent?: string;
  /** Conversation channel key for sticky routing, e.g. "telegram:123" or "tui:conn-1". */
  channelKey?: string;
  resolve: (value: string) => void;
  reject: (err: unknown) => void;
};
const messageQueue: QueuedMessage[] = [];
let processing = false;
let currentCallback: MessageCallback | undefined;
/** The channel currently being processed — tools use this to tag new workers. */
let currentSourceChannel: SourceChannel | undefined;
/** The exact source currently being processed — used for scoped cancel/result delivery. */
let currentSourceKey: string | undefined;

/** Get the channel that originated the message currently being processed. */
export function getCurrentSourceChannel(): SourceChannel | undefined {
  return currentSourceChannel;
}

export function getCurrentSourceKey(): string | undefined {
  return currentSourceKey;
}

function getSourceKey(source: MessageSource): string | undefined {
  switch (source.type) {
    case "telegram":
      return `telegram:${source.chatId}`;
    case "tui":
      return `tui:${source.connectionId}`;
    case "feishu":
      return `feishu:${source.chatId}`;
    default:
      return undefined;
  }
}

function getSessionConfig() {
  const tools = createTools({
    client: copilotClient!,
    onAgentTaskComplete: feedAgentResult,
  });
  const mcpServers = loadMcpConfig();
  const skillDirectories = getSkillDirectories();
  return { tools, mcpServers, skillDirectories };
}

/** Feed an agent task result into the orchestrator as a new turn. */
export function feedAgentResult(taskId: string, agentSlug: string, result: string): void {
  const prompt = `[Agent task completed] @${agentSlug} finished task ${taskId}:\n\n${result}`;
  sendToOrchestrator(
    prompt,
    { type: "background" },
    (_text, done) => {
      if (done && proactiveNotifyFn) {
        // Route notification to the task's origin channel
        const tasks = getActiveTasks();
        const task = tasks.find((t) => t.taskId === taskId);
        proactiveNotifyFn(_text, task?.originChannel);
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
  const memorySummary = getWikiSummary();

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
          content: getOrchestratorSystemMessage({
            selfEditEnabled: config.selfEditEnabled,
            memorySummary: memorySummary || undefined,
            agentRoster: buildAgentRoster(),
          }),
        },
        tools,
        mcpServers,
        skillDirectories,
        onPermissionRequest: orchestratorPermissionHandler,
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
      content: getOrchestratorSystemMessage({
        selfEditEnabled: config.selfEditEnabled,
        memorySummary: memorySummary || undefined,
        agentRoster: buildAgentRoster(),
      }),
    },
    tools,
    mcpServers,
    skillDirectories,
    onPermissionRequest: orchestratorPermissionHandler,
    infiniteSessions,
  });

  // Persist the session ID for future restarts
  setState(ORCHESTRATOR_SESSION_KEY, session.sessionId);
  console.log(`[max] Created orchestrator session ${session.sessionId.slice(0, 8)}…`);

  currentSessionModel = config.copilotModel;
  return session;
}

export async function initOrchestrator(client: CopilotClient): Promise<void> {
  copilotClient = client;
  const { mcpServers, skillDirectories } = getSessionConfig();

  // Initialize agent system
  ensureDefaultAgents();
  const agents = loadAgents();
  console.log(`[max] Loaded ${agents.length} agent(s): ${agents.map((a) => `@${a.slug}`).join(", ") || "(none)"}`);

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

  // Eagerly create/resume the orchestrator session
  try {
    await ensureOrchestratorSession();
  } catch (err) {
    console.error(`[max] Failed to create initial session (will retry on first message):`, err instanceof Error ? err.message : err);
  }
}

/** How long to wait for the orchestrator to finish a turn (10 min). */
const ORCHESTRATOR_TIMEOUT_MS = 600_000;

/** Send a prompt on the persistent session, return the response. */
async function executeOnSession(
  prompt: string,
  callback: MessageCallback,
  attachments?: Array<{ type: "file"; path: string; displayName?: string }>
): Promise<string> {
  const session = await ensureOrchestratorSession();
  currentCallback = callback;

  let accumulated = "";
  let toolCallExecuted = false;
  let toolCallCount = 0;
  const unsubToolDone = session.on("tool.execution_complete", () => {
    toolCallExecuted = true;
    toolCallCount++;
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
      { prompt, ...(attachments && attachments.length > 0 ? { attachments } : {}) },
      ORCHESTRATOR_TIMEOUT_MS
    );
    const finalContent = result?.data?.content || accumulated || "(No response)";
    return finalContent;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);

    // On timeout, never throw — the message was already sent to the persistent
    // session and may have been (partially) processed. Return what we have.
    if (/timeout/i.test(msg)) {
      if (accumulated.length > 0) {
        console.log(`[max] Timeout after ${ORCHESTRATOR_TIMEOUT_MS / 1000}s but have ${accumulated.length} chars — returning partial response`);
        return accumulated;
      }
      // No text yet but tool calls ran — the session is working in the background
      // (e.g. delegate_to_agent dispatched). Don't error out.
      if (toolCallCount > 0) {
        console.log(`[max] Timeout after ${ORCHESTRATOR_TIMEOUT_MS / 1000}s — ${toolCallCount} tool call(s) executed but no text yet. Session is still working.`);
        return "I'm still working on this — I've started processing but it's taking longer than expected. I'll send you the results when I'm done.";
      }
      // No text, no tool calls — the session is truly stuck
      console.log(`[max] Timeout after ${ORCHESTRATOR_TIMEOUT_MS / 1000}s with no activity. Session may be stuck.`);
      return "Sorry, that request timed out before I could start working on it. Try again or break it into smaller pieces?";
    }

    // If the session is broken, invalidate it so it's recreated on next attempt
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
    currentSourceKey = item.channelKey;
    try {
      let result: string;

      if (item.targetAgent && item.targetAgent !== "max") {
        // @mention switches the active agent — route through the orchestrator session
        // The prompt already carries the @mention context for the LLM
        setActiveAgent(item.channelKey || "default", item.targetAgent);
        result = await executeOnSession(item.prompt, item.callback, item.attachments);
      } else {
        // Route the model before executing on orchestrator
        const routeResult = await resolveModel(item.prompt, currentSessionModel || config.copilotModel, recentTiers);
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
        lastRouteResult = routeResult;

        result = await executeOnSession(item.prompt, item.callback, item.attachments);
      }

      item.resolve(result);
    } catch (err) {
      item.reject(err);
    }
    currentSourceChannel = undefined;
    currentSourceKey = undefined;
  }

  processing = false;
}

function isRecoverableError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  // Timeouts are NOT retryable on a persistent session — the message was already
  // sent and likely processed; re-sending creates "duplicate" responses.
  if (/timeout/i.test(msg)) return false;
  return /disconnect|connection|EPIPE|ECONNRESET|ECONNREFUSED|socket|closed|ENOENT|spawn|not found|expired|stale/i.test(msg);
}

export async function sendToOrchestrator(
  prompt: string,
  source: MessageSource,
  callback: MessageCallback,
  attachments?: Array<{ type: "file"; path: string; displayName?: string }>
): Promise<void> {
  const sourceLabel =
    source.type === "telegram" ? "telegram" :
    source.type === "tui" ? "tui" :
    source.type === "feishu" ? "feishu" : "background";
  logMessage("in", sourceLabel, prompt);

  // Parse @mention routing (e.g., "@coder fix the bug" → target "coder")
  const mention = parseAtMention(prompt);
  const targetAgent = mention?.agentSlug;
  const routedPrompt = mention ? mention.message : prompt;

  // Tag the prompt with its source channel
  const taggedPrompt = source.type === "background"
    ? routedPrompt
    : `[via ${sourceLabel}] ${routedPrompt}`;

  // Log role: background events are "system", user messages are "user"
  const logRole = source.type === "background" ? "system" : "user";

  // Determine the source channel for agent origin tracking
  const sourceChannel: SourceChannel | undefined =
    source.type === "telegram" ? "telegram" :
    source.type === "tui" ? "tui" :
    source.type === "feishu" ? "feishu" : undefined;
  const channelKey = getSourceKey(source);

  // Enqueue and process
  void (async () => {
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      try {
        const finalContent = await new Promise<string>((resolve, reject) => {
          messageQueue.push({ prompt: taggedPrompt, attachments, callback, sourceChannel, targetAgent, channelKey, resolve, reject });
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

/** Cancel the in-flight message and queued work for a specific source when provided. */
export async function cancelCurrentMessage(sourceKey?: string): Promise<boolean> {
  let drained = 0;
  for (let i = messageQueue.length - 1; i >= 0; i--) {
    const item = messageQueue[i];
    if (sourceKey && item.channelKey !== sourceKey) continue;
    messageQueue.splice(i, 1);
    item.reject(new Error("Cancelled"));
    drained++;
  }

  // Abort the active session request
  if (orchestratorSession && currentCallback && (!sourceKey || currentSourceKey === sourceKey)) {
    try {
      await orchestratorSession.abort();
      console.log(`[max] Aborted in-flight request`);
      return true;
    } catch (err) {
      console.error(`[max] Abort failed:`, err instanceof Error ? err.message : err);
    }
  }

  return drained > 0;
}

/** Switch the model on the live orchestrator session without destroying it. */
export function switchSessionModel(newModel: string): Promise<void> {
  if (orchestratorSession) {
    return orchestratorSession.setModel(newModel).then(() => {
      currentSessionModel = newModel;
    });
  }
  return Promise.resolve();
}

/** Return a snapshot of currently running workers for API/UI consumers. */
export function getAgentInfo(): Array<{ slug: string; name: string; model: string; taskId: string; description: string }> {
  const allTasks = getActiveTasks().filter((t) => t.status === "running");
  const registry = getAgentRegistry();
  return allTasks.map((t) => {
    const agent = registry.find((a) => a.slug === t.agentSlug);
    return {
      slug: t.agentSlug,
      name: agent?.name || t.agentSlug,
      model: agent?.model || "unknown",
      taskId: t.taskId,
      description: t.description,
    };
  });
}

/** Clean up on shutdown/restart. */
export async function shutdownAgents(): Promise<void> {
  await clearActiveTasks();
}
