import { approveAll, type CopilotClient, type CopilotSession } from "@github/copilot-sdk";
import { createTools, type WorkerInfo } from "./tools.js";
import { ORCHESTRATOR_SYSTEM_MESSAGE } from "./system-message.js";
import { config } from "../config.js";
import { loadMcpConfig } from "./mcp-config.js";
import { getSkillDirectories } from "./skills.js";
import { getState, setState } from "../store/db.js";
import { resetClient } from "./client.js";

const SESSION_ID_KEY = "orchestrator_session_id";
const MAX_RETRIES = 5;
const HEALTH_CHECK_INTERVAL_MS = 30_000;
const RECONNECT_DELAYS_MS = [1_000, 2_000, 5_000, 10_000, 20_000];

export type MessageSource =
  | { type: "telegram"; chatId: number }
  | { type: "tui"; connectionId: string }
  | { type: "background" };

export type MessageCallback = (text: string, done: boolean) => void;

type LogFn = (direction: "in" | "out", source: string, text: string) => void;
let logMessage: LogFn = () => {};

export function setMessageLogger(fn: LogFn): void {
  logMessage = fn;
}

// Proactive notification — sends unsolicited messages to the user
type ProactiveNotifyFn = (text: string) => void;
let proactiveNotifyFn: ProactiveNotifyFn | undefined;

export function setProactiveNotify(fn: ProactiveNotifyFn): void {
  proactiveNotifyFn = fn;
}

interface PendingRequest {
  prompt: string;
  source: MessageSource;
  callback: MessageCallback;
  retries?: number;
}

let orchestratorSession: CopilotSession | undefined;
let copilotClient: CopilotClient | undefined;
const workers = new Map<string, WorkerInfo>();
const requestQueue: PendingRequest[] = [];
let processing = false;
let reconnecting = false;
let healthCheckTimer: ReturnType<typeof setInterval> | undefined;

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
  const prompt = `[Background task completed] Worker '${workerName}' finished:\n\n${result}`;
  sendToOrchestrator(
    prompt,
    { type: "background" },
    (_text, done) => {
      if (done && proactiveNotifyFn) {
        proactiveNotifyFn(_text);
      }
    }
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Start periodic health check that proactively reconnects when the client drops. */
function startHealthCheck(): void {
  if (healthCheckTimer) return;
  healthCheckTimer = setInterval(async () => {
    if (!copilotClient || reconnecting) return;
    try {
      const state = copilotClient.getState();
      if (state !== "connected") {
        console.log(`[max] Health check: client state is '${state}', triggering reconnect…`);
        orchestratorSession = undefined;
        await reconnectOrchestrator();
      }
    } catch (err) {
      console.error(`[max] Health check error:`, err instanceof Error ? err.message : err);
    }
  }, HEALTH_CHECK_INTERVAL_MS);
}

export async function initOrchestrator(client: CopilotClient): Promise<void> {
  copilotClient = client;
  const { tools, mcpServers, skillDirectories } = getSessionConfig();

  console.log(`[max] Loading ${Object.keys(mcpServers).length} MCP server(s): ${Object.keys(mcpServers).join(", ") || "(none)"}`);
  console.log(`[max] Skill directories: ${skillDirectories.join(", ") || "(none)"}`);

  // Try to resume previous orchestrator session
  const savedSessionId = getState(SESSION_ID_KEY);
  if (savedSessionId) {
    try {
      console.log(`[max] Resuming orchestrator session ${savedSessionId.slice(0, 8)}…`);
      orchestratorSession = await client.resumeSession(savedSessionId, {
        streaming: true,
        tools,
        mcpServers,
        skillDirectories,
        disableResume: true,
        onPermissionRequest: approveAll,
      });
      console.log(`[max] Orchestrator session resumed successfully`);
      startHealthCheck();
      return;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.log(`[max] Could not resume session: ${msg}. Creating new session.`);
    }
  }

  // Create fresh session
  orchestratorSession = await client.createSession({
    model: config.copilotModel,
    streaming: true,
    systemMessage: {
      content: ORCHESTRATOR_SYSTEM_MESSAGE,
    },
    tools,
    mcpServers,
    skillDirectories,
    onPermissionRequest: approveAll,
  });

  // Persist session ID for future reconnection
  setState(SESSION_ID_KEY, orchestratorSession.sessionId);
  console.log(`[max] New orchestrator session: ${orchestratorSession.sessionId.slice(0, 8)}…`);
  startHealthCheck();
}

/** Attempt to reconnect the orchestrator session after a failure. */
async function reconnectOrchestrator(skipResume = false): Promise<boolean> {
  if (reconnecting) return false;
  reconnecting = true;

  try {
    console.log(`[max] Reconnecting orchestrator…${skipResume ? " (session expired, creating new)" : ""}`);

    // If the client itself is dead, create a brand new one
    if (!copilotClient || copilotClient.getState() !== "connected") {
      console.log(`[max] Client not connected (state: ${copilotClient?.getState() ?? "null"}), resetting client…`);
      try {
        copilotClient = await resetClient();
        console.log(`[max] Client reset successful, state: ${copilotClient.getState()}`);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`[max] Client reset failed: ${msg}. Will retry on next attempt.`);
        return false;
      }
    }

    const { tools, mcpServers, skillDirectories } = getSessionConfig();

    // Try to resume if we have a saved session and it hasn't been reported as gone
    if (!skipResume) {
      const savedSessionId = getState(SESSION_ID_KEY);
      if (savedSessionId) {
        try {
          orchestratorSession = await copilotClient.resumeSession(savedSessionId, {
            streaming: true,
            tools,
            mcpServers,
            skillDirectories,
            disableResume: true,
            onPermissionRequest: approveAll,
          });
          console.log(`[max] Orchestrator reconnected (resumed ${savedSessionId.slice(0, 8)}…)`);
          return true;
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          console.log(`[max] Resume failed: ${msg}. Creating new session.`);
        }
      }
    }

    // Create fresh session
    orchestratorSession = await copilotClient.createSession({
      model: config.copilotModel,
      streaming: true,
      systemMessage: { content: ORCHESTRATOR_SYSTEM_MESSAGE },
      tools,
      mcpServers,
      skillDirectories,
      onPermissionRequest: approveAll,
    });
    setState(SESSION_ID_KEY, orchestratorSession.sessionId);
    console.log(`[max] Orchestrator reconnected (new session ${orchestratorSession.sessionId.slice(0, 8)}…)`);
    return true;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[max] Reconnection failed: ${msg}`);
    orchestratorSession = undefined;
    return false;
  } finally {
    reconnecting = false;
  }
}

export async function sendToOrchestrator(
  prompt: string,
  source: MessageSource,
  callback: MessageCallback
): Promise<void> {
  requestQueue.push({ prompt, source, callback });
  processQueue();
}

function isRecoverableError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /timeout|disconnect|connection|EPIPE|ECONNRESET|ECONNREFUSED|socket|closed|ENOENT|spawn|not found|expired|stale/i.test(msg);
}

/** Check if the error specifically indicates the session no longer exists on the server. */
function isSessionGone(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /session.*not found|not found.*session|expired|stale/i.test(msg);
}

async function processQueue(): Promise<void> {
  if (processing || requestQueue.length === 0) return;
  processing = true;

  const request = requestQueue.shift()!;
  const sourceLabel =
    request.source.type === "telegram" ? "telegram" :
    request.source.type === "tui" ? "tui" : "background";
  logMessage("in", sourceLabel, request.prompt);

  if (!orchestratorSession) {
    // Try to reconnect before giving up
    const recovered = await reconnectOrchestrator();
    if (!recovered) {
      request.callback("Max is not ready yet. Please try again in a moment.", true);
      processing = false;
      processQueue();
      return;
    }
  }

  let accumulated = "";
  let unsubDelta: (() => void) | undefined;
  let unsubIdle: (() => void) | undefined;

  try {
    unsubDelta = orchestratorSession!.on("assistant.message_delta", (event) => {
      accumulated += event.data.deltaContent;
      request.callback(accumulated, false);
    });

    unsubIdle = orchestratorSession!.on("session.idle", () => {
      // Cleanup happens below after sendAndWait resolves
    });

    const result = await orchestratorSession!.sendAndWait({ prompt: request.prompt }, 300_000);
    const finalContent = result?.data?.content || accumulated || "(No response)";
    logMessage("out", sourceLabel, finalContent);
    request.callback(finalContent, true);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);

    if (isRecoverableError(err)) {
      const sessionGone = isSessionGone(err);
      const retries = (request.retries ?? 0) + 1;
      const delay = RECONNECT_DELAYS_MS[Math.min(retries - 1, RECONNECT_DELAYS_MS.length - 1)];
      console.error(`[max] ${sessionGone ? "Session expired" : "Connection error"}: ${msg}. Retry ${retries}/${MAX_RETRIES} after ${delay}ms…`);
      orchestratorSession = undefined;

      if (retries <= MAX_RETRIES) {
        await sleep(delay);
        const recovered = await reconnectOrchestrator(sessionGone);
        if (recovered) {
          request.retries = retries;
          requestQueue.unshift(request);
        } else {
          request.callback(`Connection lost and reconnect failed: ${msg}`, true);
        }
      } else {
        request.callback(`Connection lost after ${MAX_RETRIES} retries: ${msg}`, true);
      }
    } else {
      request.callback(`Error: ${msg}`, true);
    }
  } finally {
    unsubDelta?.();
    unsubIdle?.();
    processing = false;
    processQueue();
  }
}

export function getWorkers(): Map<string, WorkerInfo> {
  return workers;
}
