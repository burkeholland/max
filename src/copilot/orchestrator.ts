import { approveAll, type CopilotClient, type CopilotSession } from "@github/copilot-sdk";
import { createTools, type WorkerInfo } from "./tools.js";
import { ORCHESTRATOR_SYSTEM_MESSAGE } from "./system-message.js";
import { config } from "../config.js";
import { loadMcpConfig } from "./mcp-config.js";
import { getSkillDirectories } from "./skills.js";
import { getState, setState } from "../store/db.js";

const SESSION_ID_KEY = "orchestrator_session_id";

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

const MAX_RETRIES = 2;

let orchestratorSession: CopilotSession | undefined;
let copilotClient: CopilotClient | undefined;
const workers = new Map<string, WorkerInfo>();
const requestQueue: PendingRequest[] = [];
let processing = false;
let reconnecting = false;

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
}

/** Attempt to reconnect the orchestrator session after a failure. */
async function reconnectOrchestrator(): Promise<boolean> {
  if (reconnecting || !copilotClient) return false;
  reconnecting = true;

  try {
    console.log(`[max] Reconnecting orchestrator…`);

    // Ensure client is connected
    if (copilotClient.getState() !== "connected") {
      console.log(`[max] Client disconnected, restarting…`);
      await copilotClient.start();
    }

    const { tools, mcpServers, skillDirectories } = getSessionConfig();
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
      } catch {
        console.log(`[max] Resume failed, creating new session`);
      }
    }

    // Fallback: create new session
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

function isConnectionError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /timeout|disconnect|connection|EPIPE|ECONNRESET|ECONNREFUSED|socket|closed/i.test(msg);
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

  const unsubDelta = orchestratorSession!.on("assistant.message_delta", (event) => {
    accumulated += event.data.deltaContent;
    request.callback(accumulated, false);
  });

  const unsubIdle = orchestratorSession!.on("session.idle", () => {
    // Cleanup happens below after sendAndWait resolves
  });

  try {
    const result = await orchestratorSession!.sendAndWait({ prompt: request.prompt }, 300_000);
    const finalContent = result?.data?.content || accumulated || "(No response)";
    logMessage("out", sourceLabel, finalContent);
    request.callback(finalContent, true);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);

    if (isConnectionError(err)) {
      console.error(`[max] Connection error: ${msg}. Attempting reconnect…`);
      orchestratorSession = undefined;
      const retries = (request.retries ?? 0) + 1;
      if (retries <= MAX_RETRIES) {
        const recovered = await reconnectOrchestrator();
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
    unsubDelta();
    unsubIdle();
    processing = false;
    processQueue();
  }
}

export function getWorkers(): Map<string, WorkerInfo> {
  return workers;
}
