import type { CopilotClient, CopilotSession } from "@github/copilot-sdk";
import { createTools, type WorkerInfo } from "./tools.js";
import { ORCHESTRATOR_SYSTEM_MESSAGE } from "./system-message.js";
import { config } from "../config.js";

export type MessageSource =
  | { type: "telegram"; chatId: number }
  | { type: "tui"; connectionId: string };

export type MessageCallback = (text: string, done: boolean) => void;

interface PendingRequest {
  prompt: string;
  source: MessageSource;
  callback: MessageCallback;
}

let orchestratorSession: CopilotSession | undefined;
const workers = new Map<string, WorkerInfo>();
const requestQueue: PendingRequest[] = [];
let processing = false;

export async function initOrchestrator(client: CopilotClient): Promise<void> {
  const tools = createTools({ client, workers });

  orchestratorSession = await client.createSession({
    model: config.copilotModel,
    streaming: true,
    systemMessage: {
      content: ORCHESTRATOR_SYSTEM_MESSAGE,
    },
    tools,
  });
}

export async function sendToOrchestrator(
  prompt: string,
  source: MessageSource,
  callback: MessageCallback
): Promise<void> {
  requestQueue.push({ prompt, source, callback });
  processQueue();
}

async function processQueue(): Promise<void> {
  if (processing || requestQueue.length === 0) return;
  processing = true;

  const request = requestQueue.shift()!;

  if (!orchestratorSession) {
    request.callback("Max is not ready yet. Please try again in a moment.", true);
    processing = false;
    processQueue();
    return;
  }

  let accumulated = "";

  const unsubDelta = orchestratorSession.on("assistant.message_delta", (event) => {
    accumulated += event.data.deltaContent;
    request.callback(accumulated, false);
  });

  const unsubIdle = orchestratorSession.on("session.idle", () => {
    // Cleanup happens below after sendAndWait resolves
  });

  try {
    const result = await orchestratorSession.sendAndWait({ prompt: request.prompt });
    const finalContent = result?.data?.content || accumulated || "(No response)";
    request.callback(finalContent, true);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    request.callback(`Error: ${msg}`, true);
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
