import * as Lark from "@larksuiteoapi/node-sdk";
import { config } from "../config.js";
import { sendToOrchestrator, getLastRouteResult } from "../copilot/orchestrator.js";
import { restartDaemon } from "../daemon.js";
import {
  HELP_TEXT,
  START_TEXT,
  handleAgents,
  handleAuto,
  handleCancel,
  handleMemory,
  handleModel,
  handleModels,
  handleSkills,
} from "../commands.js";
import { buildCardContent, buildTextContent, chunkMessage } from "./formatter.js";

let client: Lark.Client | undefined;
let wsClient: Lark.WSClient | undefined;
let eventDispatcher: Lark.EventDispatcher | undefined;

function resolveDomain(domain: "feishu" | "lark"): Lark.Domain {
  return domain === "lark" ? Lark.Domain.Lark : Lark.Domain.Feishu;
}

/** Strip leading @mentions of any user from a Feishu message. */
function stripMentions(text: string): string {
  // Feishu emits mention placeholders like "@_user_1" / "@_all" interleaved
  // with plain text. Remove all leading mention tokens plus surrounding
  // whitespace; preserve any subsequent body verbatim.
  return text.replace(/^(?:\s*@[_\w]+\s*)+/, "").trim();
}

/** Decode the JSON message.content payload for a text message. */
function extractText(rawContent: string): string {
  try {
    const parsed = JSON.parse(rawContent) as { text?: unknown };
    return typeof parsed.text === "string" ? parsed.text : "";
  } catch {
    return "";
  }
}

type MessageReceiveEvent = {
  sender: {
    sender_id?: { open_id?: string; user_id?: string; union_id?: string };
    sender_type?: string;
  };
  message: {
    message_id: string;
    chat_id: string;
    chat_type: "p2p" | "group" | string;
    message_type: string;
    content: string;
  };
};

/** Maybe-handle a slash command. Returns the reply text, or null if not a command. */
async function maybeHandleCommand(text: string, chatIdForCommands: string): Promise<string | null> {
  const trimmed = text.trim();
  if (!trimmed.startsWith("/")) return null;

  const [cmdRaw, ...rest] = trimmed.slice(1).split(/\s+/);
  const cmd = cmdRaw.toLowerCase();
  const arg = rest.join(" ");

  switch (cmd) {
    case "start":
      return START_TEXT;
    case "help":
      return HELP_TEXT;
    case "cancel":
      return await handleCancel(`feishu:${chatIdForCommands}`);
    case "model":
      return await handleModel(arg);
    case "models":
      return await handleModels();
    case "memory":
      return handleMemory();
    case "skills":
      return handleSkills();
    case "workers":
    case "agents":
      return handleAgents();
    case "auto":
      return handleAuto();
    case "restart":
      setTimeout(() => {
        restartDaemon().catch((err) => {
          console.error("[max] Restart failed:", err);
        });
      }, 500);
      return "⏳ Restarting Max...";
    default:
      return null;
  }
}

async function sendChunkedReply(
  messageId: string,
  chatId: string,
  text: string
): Promise<void> {
  const chunks = chunkMessage(text);
  for (const chunk of chunks) {
    await sendReply(messageId, chatId, chunk);
  }
}

/** Reply to a Feishu message; falls back to a direct send if reply is unavailable. */
async function sendReply(
  messageId: string,
  chatId: string,
  text: string
): Promise<void> {
  if (!client) return;
  const card = buildCardContent(text);

  try {
    await client.im.message.reply({
      path: { message_id: messageId },
      data: { content: card, msg_type: "interactive" },
    });
    return;
  } catch (err) {
    // Fall through to direct send. Common cause: parent message withdrawn
    // (codes 230011 / 231003) — pattern from openclaw extensions/feishu.
    if (!isWithdrawnReplyError(err)) {
      console.error("[max] Feishu reply failed, falling back to direct send:", err);
    }
  }

  try {
    await client.im.message.create({
      params: { receive_id_type: "chat_id" },
      data: { receive_id: chatId, content: card, msg_type: "interactive" },
    });
  } catch (err) {
    // Last resort: try plain text in case the card payload is the problem.
    try {
      await client.im.message.create({
        params: { receive_id_type: "chat_id" },
        data: { receive_id: chatId, content: buildTextContent(text), msg_type: "text" },
      });
    } catch (err2) {
      console.error("[max] Feishu direct send failed:", err2 ?? err);
    }
  }
}

function isWithdrawnReplyError(err: unknown): boolean {
  if (typeof err !== "object" || err === null) return false;
  const code = (err as { code?: number }).code;
  if (code === 230011 || code === 231003) return true;
  const response = (err as { response?: { data?: { code?: number } } }).response;
  return response?.data?.code === 230011 || response?.data?.code === 231003;
}

export function createBot(): { client: Lark.Client; wsClient: Lark.WSClient } {
  if (!config.feishuAppId || !config.feishuAppSecret) {
    throw new Error(
      "Feishu credentials are missing. Run 'max setup' and enter your Feishu App ID and App Secret."
    );
  }
  if (!config.feishuAuthorizedOpenId) {
    throw new Error(
      "Feishu authorized open_id is missing. Run 'max setup' and enter the open_id of the user allowed to control Max."
    );
  }

  const domain = resolveDomain(config.feishuDomain);

  client = new Lark.Client({
    appId: config.feishuAppId,
    appSecret: config.feishuAppSecret,
    appType: Lark.AppType.SelfBuild,
    domain,
  });

  wsClient = new Lark.WSClient({
    appId: config.feishuAppId,
    appSecret: config.feishuAppSecret,
    domain,
    loggerLevel: Lark.LoggerLevel.warn,
  });

  const dispatcher = new Lark.EventDispatcher({}).register({
    "im.message.receive_v1": async (data: unknown) => {
      const event = data as MessageReceiveEvent;
      const senderOpenId = event.sender?.sender_id?.open_id;

      // Auth: only the configured user may control Max.
      if (!senderOpenId || senderOpenId !== config.feishuAuthorizedOpenId) {
        return;
      }

      // v1: ignore group chats entirely (matches Telegram's single-user model).
      if (event.message.chat_type !== "p2p") {
        return;
      }

      // v1: only handle plain text messages.
      if (event.message.message_type !== "text") {
        await sendChunkedReply(
          event.message.message_id,
          event.message.chat_id,
          "_(Sorry — I can only read text messages right now.)_"
        );
        return;
      }

      const rawText = extractText(event.message.content);
      const text = stripMentions(rawText);
      if (!text) return;

      // Slash command short-circuit.
      const cmdReply = await maybeHandleCommand(text, event.message.chat_id);
      if (cmdReply !== null) {
        await sendChunkedReply(event.message.message_id, event.message.chat_id, cmdReply);
        return;
      }

      // Otherwise, hand off to the orchestrator.
      sendToOrchestrator(
        text,
        {
          type: "feishu",
          chatId: event.message.chat_id,
          messageId: event.message.message_id,
          openId: senderOpenId,
        },
        (responseText: string, done: boolean) => {
          if (!done) return;
          void (async () => {
            const routeResult = getLastRouteResult();
            const suffix =
              routeResult && routeResult.routerMode === "auto"
                ? `\n\n_⚡ auto · ${routeResult.model}_`
                : "";
            const final = responseText + suffix;
            await sendChunkedReply(event.message.message_id, event.message.chat_id, final);
          })();
        }
      );
    },
  });

  // Wire up WS → dispatcher on start().
  eventDispatcher = dispatcher;

  return { client, wsClient };
}

export async function startBot(): Promise<void> {
  if (!wsClient || !eventDispatcher) throw new Error("Feishu bot not created");
  console.log("[max] Feishu bot starting...");
  // WSClient.start is fire-and-forget — it manages its own reconnect loop.
  try {
    wsClient.start({ eventDispatcher });
    console.log("[max] Feishu websocket loop started; waiting for incoming events");
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    if (/invalid|unauthorized|app_id|secret/i.test(message)) {
      console.error(
        "[max] ⚠️ Feishu app credentials are invalid. Run 'max setup' and re-enter your Feishu App ID and App Secret."
      );
    } else {
      console.error("[max] ❌ Feishu bot failed to start:", message);
    }
  }
}

export async function stopBot(): Promise<void> {
  // Lark WSClient does not expose a clean stop in all versions; best-effort.
  const anyClient = wsClient as unknown as { stop?: () => void; close?: () => void };
  try {
    anyClient.stop?.();
    anyClient.close?.();
  } catch {
    /* best effort */
  }
  wsClient = undefined;
  client = undefined;
  eventDispatcher = undefined;
}

/** Send an unsolicited message to the authorized Feishu user. */
export async function sendProactiveMessage(text: string): Promise<void> {
  if (!client || !config.feishuAuthorizedOpenId) return;
  const chunks = chunkMessage(text);
  for (const chunk of chunks) {
    try {
      await client.im.message.create({
        params: { receive_id_type: "open_id" },
        data: {
          receive_id: config.feishuAuthorizedOpenId,
          content: buildCardContent(chunk),
          msg_type: "interactive",
        },
      });
    } catch (err) {
      try {
        await client.im.message.create({
          params: { receive_id_type: "open_id" },
          data: {
            receive_id: config.feishuAuthorizedOpenId,
            content: buildTextContent(chunk),
            msg_type: "text",
          },
        });
      } catch (err2) {
        console.error("[max] Feishu proactive send failed:", err2 ?? err);
      }
    }
  }
}
