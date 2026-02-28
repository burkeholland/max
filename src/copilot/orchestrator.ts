import { approveAll, type CopilotClient, type CopilotSession } from "@github/copilot-sdk";
import { createTools, type WorkerInfo } from "./tools.js";
import { getOrchestratorSystemMessage } from "./system-message.js";
import { config } from "../config.js";
import { loadMcpConfig } from "./mcp-config.js";
import { getSkillDirectories } from "./skills.js";
import { resetClient } from "./client.js";
import { logConversation, getState, setState, getMemorySummary } from "../store/db.js";
import { SESSIONS_DIR } from "../paths.js";

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

// Persistent orchestrator session
let orchestratorSession: CopilotSession | undefined;

// Message queue — serializes access to the single persistent session
type QueuedMessage = {
  prompt: string;
  callback: MessageCallback;
  sourceChannel?: "telegram" | "tui";
  resolve: (value: string) => void;
  reject: (err: unknown) => void;
};
const messageQueue: QueuedMessage[] = [];
let processing = false;
let currentCallback: MessageCallback | undefined;
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
      }
    } catch (err) {
      console.error(`[max] Health check error:`, err instanceof Error ? err.message : err);
    }
  }, HEALTH_CHECK_INTERVAL_MS);
}

/** Create or resume the persistent orchestrator session. */
async function ensureOrchestratorSession(): Promise<CopilotSession> {
  if (orchestratorSession) return orchestratorSession;

  const client = await ensureClient();
  const { tools, mcpServers, skillDirectories } = getSessionConfig();
  const memorySummary = getMemorySummary();

  // Try to resume a previous session
  const savedSessionId = getState(ORCHESTRATOR_SESSION_KEY);
  if (savedSessionId) {
    try {
      console.log(`[max] Resuming orchestrator session ${savedSessionId.slice(0, 8)}…`);
      orchestratorSession = await client.resumeSession(savedSessionId, {
        model: config.copilotModel,
        configDir: SESSIONS_DIR,
        streaming: true,
        systemMessage: {
          content: getOrchestratorSystemMessage(memorySummary || undefined),
        },
        tools,
        mcpServers,
        skillDirectories,
        onPermissionRequest: approveAll,
      });
      console.log(`[max] Resumed orchestrator session successfully`);
      return orchestratorSession;
    } catch (err) {
      console.log(`[max] Could not resume session: ${err instanceof Error ? err.message : err}. Creating new.`);
    }
  }

  // Create a fresh session
  console.log(`[max] Creating new persistent orchestrator session`);
  orchestratorSession = await client.createSession({
    model: config.copilotModel,
    configDir: SESSIONS_DIR,
    streaming: true,
    systemMessage: {
      content: getOrchestratorSystemMessage(memorySummary || undefined),
    },
    tools,
    mcpServers,
    skillDirectories,
    onPermissionRequest: approveAll,
  });

  // Persist the session ID for future restarts
  setState(ORCHESTRATOR_SESSION_KEY, orchestratorSession.sessionId);
  console.log(`[max] Created orchestrator session ${orchestratorSession.sessionId.slice(0, 8)}…`);
  return orchestratorSession;
}

export async function initOrchestrator(client: CopilotClient): Promise<void> {
  copilotClient = client;
  const { mcpServers, skillDirectories } = getSessionConfig();

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

/** Send a prompt on the persistent session, return the response. */
async function executeOnSession(prompt: string, callback: MessageCallback): Promise<string> {
  const session = await ensureOrchestratorSession();
  currentCallback = callback;

  let accumulated = "";
  const unsubDelta = session.on("assistant.message_delta", (event) => {
    accumulated += event.data.deltaContent;
    callback(accumulated, false);
  });

  try {
    const result = await session.sendAndWait({ prompt }, 300_000);
    const finalContent = result?.data?.content || accumulated || "(No response)";
    return finalContent;
  } catch (err) {
    // If the session is broken, invalidate it so it's recreated on next attempt
    const msg = err instanceof Error ? err.message : String(err);
    if (/closed|destroy|disposed|invalid|expired/i.test(msg)) {
      console.log(`[max] Session appears dead, will recreate: ${msg}`);
      orchestratorSession = undefined;
    }
    throw err;
  } finally {
    unsubDelta();
    currentCallback = undefined;
  }
}

/** Process the message queue one at a time. */
async function processQueue(): Promise<void> {
  if (processing) return;
  processing = true;

  while (messageQueue.length > 0) {
    const item = messageQueue.shift()!;
    currentSourceChannel = item.sourceChannel;
    try {
      const result = await executeOnSession(item.prompt, item.callback);
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
  callback: MessageCallback
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
          messageQueue.push({ prompt: taggedPrompt, callback, sourceChannel, resolve, reject });
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

  // Abort the active session request
  if (orchestratorSession && currentCallback) {
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

export function getWorkers(): Map<string, WorkerInfo> {
  return workers;
}
