import { Bot, type Context } from "grammy";
import { config, persistModel } from "../config.js";
import { sendToOrchestrator, cancelCurrentMessage, getWorkers, getLastRouteResult } from "../copilot/orchestrator.js";
import { chunkMessage, toTelegramMarkdown } from "./formatter.js";
import { parseIndex } from "../wiki/index-manager.js";
import { ensureWikiStructure } from "../wiki/fs.js";
import { listSkills } from "../copilot/skills.js";
import { restartDaemon } from "../daemon.js";
import { getRouterConfig, updateRouterConfig } from "../copilot/router.js";
import { tmpdir } from "os";
import { join } from "path";
import { writeFile, unlink } from "fs/promises";

let bot: Bot | undefined;

/** Download a Telegram photo (largest size) to a temp file and return the path. */
async function downloadTelegramPhoto(
  fileId: string,
  label: string
): Promise<string | undefined> {
  if (!bot || !config.telegramBotToken) return undefined;
  try {
    const file = await bot.api.getFile(fileId);
    if (!file.file_path) return undefined;
    const url = `https://api.telegram.org/file/bot${config.telegramBotToken}/${file.file_path}`;
    const response = await fetch(url);
    if (!response.ok) return undefined;
    const buffer = new Uint8Array(await response.arrayBuffer());
    const ext = file.file_path.split(".").pop() ?? "jpg";
    const tmpPath = join(tmpdir(), `max-tg-${label}-${Date.now()}.${ext}`);
    await writeFile(tmpPath, buffer);
    return tmpPath;
  } catch {
    return undefined;
  }
}

/** Build reply context (prefix text + attachments) from a replied-to message. */
async function buildReplyContext(
  replyTo: NonNullable<Context["message"]>["reply_to_message"]
): Promise<{ prefix: string; attachments: Array<{ type: "file"; path: string; displayName?: string }> }> {
  if (!replyTo) return { prefix: "", attachments: [] };

  const attachments: Array<{ type: "file"; path: string; displayName?: string }> = [];
  let prefix = "";

  if ("text" in replyTo && replyTo.text) {
    prefix = `[Replying to: "${replyTo.text}"]\n\n`;
  } else if ("caption" in replyTo && replyTo.caption) {
    prefix = `[Replying to message with caption: "${replyTo.caption}"]\n\n`;
  } else {
    prefix = "[Replying to a message]\n\n";
  }

  // If the replied-to message contains a photo, download the largest size
  if ("photo" in replyTo && replyTo.photo && replyTo.photo.length > 0) {
    const largest = replyTo.photo[replyTo.photo.length - 1];
    const tmpPath = await downloadTelegramPhoto(largest.file_id, "reply");
    if (tmpPath) {
      attachments.push({ type: "file", path: tmpPath, displayName: "replied-to-image" });
      if (!("text" in replyTo && replyTo.text)) {
        prefix = "[Replying to an image" + ("caption" in replyTo && replyTo.caption ? ` with caption: "${replyTo.caption}"` : "") + "]\n\n";
      }
    }
  }

  return { prefix, attachments };
}

/** Delete temp attachment files after they've been sent to the AI. */
async function cleanupAttachments(
  attachments: Array<{ type: "file"; path: string }>
): Promise<void> {
  for (const a of attachments) {
    try { await unlink(a.path); } catch { /* best-effort */ }
  }
}

export function createBot(): Bot {
  if (!config.telegramBotToken) {
    throw new Error("Telegram bot token is missing. Run 'max setup' and enter the bot token from @BotFather.");
  }
  if (config.authorizedUserId === undefined) {
    throw new Error("Telegram user ID is missing. Run 'max setup' and enter your Telegram user ID (get it from @userinfobot).");
  }
  bot = new Bot(config.telegramBotToken);

  // Auth middleware — only allow the authorized user; reject all messages if no user ID is configured
  bot.use(async (ctx, next) => {
    if (config.authorizedUserId === undefined || ctx.from?.id !== config.authorizedUserId) {
      return; // Silently ignore unauthorized or unconfigured users
    }
    await next();
  });

  // /start and /help
  bot.command("start", (ctx) => ctx.reply("Max is online. Send me anything."));
  bot.command("help", (ctx) =>
    ctx.reply(
      "I'm Max, your AI daemon.\n\n" +
        "Just send me a message and I'll handle it.\n\n" +
        "Commands:\n" +
        "/cancel — Cancel the current message\n" +
        "/model — Show current model\n" +
        "/model <name> — Switch model\n" +
        "/models — List all available models\n" +
        "/auto — Toggle auto model routing\n" +
        "/memory — Show stored memories\n" +
        "/skills — List installed skills\n" +
        "/workers — List active worker sessions\n" +
        "/restart — Restart Max\n" +
        "/help — Show this help"
    )
  );
  bot.command("cancel", async (ctx) => {
    const cancelled = await cancelCurrentMessage();
    await ctx.reply(cancelled ? "⛔ Cancelled." : "Nothing to cancel.");
  });
  bot.command("model", async (ctx) => {
    const arg = ctx.match?.trim();
    if (arg) {
      // Validate against available models before persisting
      try {
        const { getClient } = await import("../copilot/client.js");
        const client = await getClient();
        const models = await client.listModels();
        const match = models.find((m) => m.id === arg);
        if (!match) {
          const suggestions = models
            .filter((m) => m.id.includes(arg) || m.id.toLowerCase().includes(arg.toLowerCase()))
            .map((m) => m.id);
          const hint = suggestions.length > 0 ? ` Did you mean: ${suggestions.join(", ")}?` : "";
          await ctx.reply(`Model '${arg}' not found.${hint}`);
          return;
        }
      } catch {
        // If validation fails (client not ready), allow the switch — will fail on next message if wrong
      }
      const previous = config.copilotModel;
      config.copilotModel = arg;
      persistModel(arg);
      await ctx.reply(`Model: ${previous} → ${arg}`);
    } else {
      await ctx.reply(`Current model: ${config.copilotModel}`);
    }
  });
  bot.command("models", async (ctx) => {
    try {
      const { getClient } = await import("../copilot/client.js");
      const client = await getClient();
      const models = await client.listModels();
      if (models.length === 0) {
        await ctx.reply("No models available.");
        return;
      }
      const lines = models.map((m) =>
        m.id === config.copilotModel ? `• ${m.id} ← current` : `• ${m.id}`
      );
      await ctx.reply(lines.join("\n"));
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await ctx.reply(`Failed to list models: ${msg}`);
    }
  });
  bot.command("memory", async (ctx) => {
    ensureWikiStructure();
    const entries = parseIndex();
    if (entries.length === 0) {
      await ctx.reply("No wiki pages yet.");
    } else {
      const lines = entries.map((e) => {
        let line = `• ${e.title}: ${e.summary}`;
        if (e.updated) line += ` (${e.updated})`;
        return line;
      });
      await ctx.reply(lines.join("\n") + `\n\n${entries.length} wiki pages total`);
    }
  });
  bot.command("skills", async (ctx) => {
    const skills = listSkills();
    if (skills.length === 0) {
      await ctx.reply("No skills installed.");
    } else {
      const lines = skills.map((s) => `• ${s.name} (${s.source}) — ${s.description}`);
      await ctx.reply(lines.join("\n"));
    }
  });
  bot.command("workers", async (ctx) => {
    const workers = Array.from(getWorkers().values());
    if (workers.length === 0) {
      await ctx.reply("No active worker sessions.");
    } else {
      const lines = workers.map((w) => `• ${w.name} (${w.workingDir}) — ${w.status}`);
      await ctx.reply(lines.join("\n"));
    }
  });
  bot.command("restart", async (ctx) => {
    await ctx.reply("⏳ Restarting Max...");
    setTimeout(() => {
      restartDaemon().catch((err) => {
        console.error("[max] Restart failed:", err);
      });
    }, 500);
  });
  bot.command("auto", async (ctx) => {
    const current = getRouterConfig();
    const newState = !current.enabled;
    updateRouterConfig({ enabled: newState });
    const label = newState
      ? "⚡ Auto mode on"
      : `Auto mode off · using ${config.copilotModel}`;
    await ctx.reply(label);
  });

  // Handle all text messages
  bot.on("message:text", async (ctx) => {
    const chatId = ctx.chat.id;
    const userMessageId = ctx.message.message_id;
    const replyParams = { message_id: userMessageId };

    // Build reply context if this message is a reply to another
    const { prefix, attachments: replyAttachments } = await buildReplyContext(ctx.message.reply_to_message);
    const prompt = prefix + ctx.message.text;

    // Show "typing..." indicator, repeat every 4s while processing
    let typingInterval: ReturnType<typeof setInterval> | undefined;
    const startTyping = () => {
      void ctx.replyWithChatAction("typing").catch(() => {});
      typingInterval = setInterval(() => {
        void ctx.replyWithChatAction("typing").catch(() => {});
      }, 4000);
    };
    const stopTyping = () => {
      if (typingInterval) {
        clearInterval(typingInterval);
        typingInterval = undefined;
      }
    };

    startTyping();

    sendToOrchestrator(
      prompt,
      { type: "telegram", chatId, messageId: userMessageId },
      (text: string, done: boolean) => {
        if (done) {
          stopTyping();
          void cleanupAttachments(replyAttachments);
          // Send final message — use chunking for long responses, reply-quote original
          void (async () => {
            // Append model indicator
            const routeResult = getLastRouteResult();
            let indicatorSuffix = "";
            if (routeResult && routeResult.routerMode === "auto") {
              indicatorSuffix = `\n\n_⚡ auto · ${routeResult.model}_`;
            }
            const formatted = toTelegramMarkdown(text) + indicatorSuffix;
            const chunks = chunkMessage(formatted);
            const fallbackText = routeResult && routeResult.routerMode === "auto"
              ? text + `\n\n⚡ auto · ${routeResult.model}`
              : text;
            const fallbackChunks = chunkMessage(fallbackText);
            const sendChunk = async (chunk: string, fallback: string, isFirst: boolean) => {
              const opts = isFirst
                ? { parse_mode: "MarkdownV2" as const, reply_parameters: replyParams }
                : { parse_mode: "MarkdownV2" as const };
              await ctx.reply(chunk, opts).catch(
                () => ctx.reply(fallback, isFirst ? { reply_parameters: replyParams } : {})
              );
            };
            try {
              for (let i = 0; i < chunks.length; i++) {
                await sendChunk(chunks[i], fallbackChunks[i] ?? chunks[i], i === 0);
              }
            } catch {
              try {
                for (let i = 0; i < fallbackChunks.length; i++) {
                  await ctx.reply(fallbackChunks[i], i === 0 ? { reply_parameters: replyParams } : {});
                }
              } catch {
                // Nothing more we can do
              }
            }
          })();
        }
      },
      replyAttachments.length > 0 ? replyAttachments : undefined
    );
  });

  // Handle photo messages (with optional caption and optional reply context)
  bot.on("message:photo", async (ctx) => {
    const chatId = ctx.chat.id;
    const userMessageId = ctx.message.message_id;
    const replyParams = { message_id: userMessageId };

    // Download the largest photo size
    const photos = ctx.message.photo;
    const largest = photos[photos.length - 1];
    const photoPath = await downloadTelegramPhoto(largest.file_id, "photo");

    const attachments: Array<{ type: "file"; path: string; displayName?: string }> = [];
    if (photoPath) {
      attachments.push({ type: "file", path: photoPath, displayName: "image" });
    }

    // Build reply context if this is a reply
    const { prefix: replyPrefix, attachments: replyAttachments } = await buildReplyContext(ctx.message.reply_to_message);
    attachments.push(...replyAttachments);

    const caption = ctx.message.caption ?? "";
    const prompt = replyPrefix + (caption || "[Image attached]");

    const allAttachments = attachments.length > 0 ? attachments : undefined;

    // Show "typing..." indicator
    let typingInterval: ReturnType<typeof setInterval> | undefined;
    const startTyping = () => {
      void ctx.replyWithChatAction("typing").catch(() => {});
      typingInterval = setInterval(() => {
        void ctx.replyWithChatAction("typing").catch(() => {});
      }, 4000);
    };
    const stopTyping = () => {
      if (typingInterval) {
        clearInterval(typingInterval);
        typingInterval = undefined;
      }
    };

    startTyping();

    sendToOrchestrator(
      prompt,
      { type: "telegram", chatId, messageId: userMessageId },
      (text: string, done: boolean) => {
        if (done) {
          stopTyping();
          void cleanupAttachments(attachments);
          void (async () => {
            const routeResult = getLastRouteResult();
            let indicatorSuffix = "";
            if (routeResult && routeResult.routerMode === "auto") {
              indicatorSuffix = `\n\n_⚡ auto · ${routeResult.model}_`;
            }
            const formatted = toTelegramMarkdown(text) + indicatorSuffix;
            const chunks = chunkMessage(formatted);
            const fallbackText = routeResult && routeResult.routerMode === "auto"
              ? text + `\n\n⚡ auto · ${routeResult.model}`
              : text;
            const fallbackChunks = chunkMessage(fallbackText);
            const sendChunk = async (chunk: string, fallback: string, isFirst: boolean) => {
              const opts = isFirst
                ? { parse_mode: "MarkdownV2" as const, reply_parameters: replyParams }
                : { parse_mode: "MarkdownV2" as const };
              await ctx.reply(chunk, opts).catch(
                () => ctx.reply(fallback, isFirst ? { reply_parameters: replyParams } : {})
              );
            };
            try {
              for (let i = 0; i < chunks.length; i++) {
                await sendChunk(chunks[i], fallbackChunks[i] ?? chunks[i], i === 0);
              }
            } catch {
              try {
                for (let i = 0; i < fallbackChunks.length; i++) {
                  await ctx.reply(fallbackChunks[i], i === 0 ? { reply_parameters: replyParams } : {});
                }
              } catch {
                // Nothing more we can do
              }
            }
          })();
        }
      },
      allAttachments
    );
  });

  return bot;
}

export async function startBot(): Promise<void> {
  if (!bot) throw new Error("Bot not created");
  console.log("[max] Telegram bot starting...");
  bot.start({
    onStart: () => console.log("[max] Telegram bot connected"),
  }).catch((err: any) => {
    if (err?.error_code === 401) {
      console.error("[max] ⚠️ Telegram bot token is invalid or expired. Run 'max setup' and re-enter your bot token from @BotFather.");
    } else if (err?.error_code === 409) {
      console.error("[max] ⚠️ Another bot instance is already running with this token. Stop the other instance first.");
    } else {
      console.error("[max] ❌ Telegram bot failed to start:", err?.message || err);
    }
  });
}

export async function stopBot(): Promise<void> {
  if (bot) {
    await bot.stop();
  }
}

/** Send an unsolicited message to the authorized user (for background task completions). */
export async function sendProactiveMessage(text: string): Promise<void> {
  if (!bot || config.authorizedUserId === undefined) return;
  const formatted = toTelegramMarkdown(text);
  const chunks = chunkMessage(formatted);
  const fallbackChunks = chunkMessage(text);
  for (let i = 0; i < chunks.length; i++) {
    try {
      await bot.api.sendMessage(config.authorizedUserId, chunks[i], { parse_mode: "MarkdownV2" });
    } catch {
      try {
        await bot.api.sendMessage(config.authorizedUserId, fallbackChunks[i] ?? chunks[i]);
      } catch {
        // Bot may not be connected yet
      }
    }
  }
}

/** Send a photo to the authorized user. Accepts a file path or URL. */
export async function sendPhoto(photo: string, caption?: string): Promise<void> {
  if (!bot || config.authorizedUserId === undefined) return;
  try {
    const { InputFile } = await import("grammy");
    const input = photo.startsWith("http") ? photo : new InputFile(photo);
    await bot.api.sendPhoto(config.authorizedUserId, input, {
      caption,
    });
  } catch (err) {
    console.error("[max] Failed to send photo:", err instanceof Error ? err.message : err);
    throw err;
  }
}
