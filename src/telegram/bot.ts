import { Bot, type Context } from "grammy";
import { config, persistModel } from "../config.js";
import { sendToOrchestrator, cancelCurrentMessage, getWorkers } from "../copilot/orchestrator.js";
import { chunkMessage, toTelegramMarkdown } from "./formatter.js";
import { searchMemories } from "../store/db.js";
import { listSkills } from "../copilot/skills.js";
import { restartDaemon } from "../daemon.js";

let bot: Bot | undefined;

export function createBot(): Bot {
  if (!config.telegramBotToken) {
    throw new Error("TELEGRAM_BOT_TOKEN is required to create the bot. Run 'max setup' first.");
  }
  bot = new Bot(config.telegramBotToken);

  // Auth middleware — only allow the authorized user
  bot.use(async (ctx, next) => {
    if (config.authorizedUserId !== undefined && ctx.from?.id !== config.authorizedUserId) {
      return; // Silently ignore unauthorized users
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
      const previous = config.copilotModel;
      config.copilotModel = arg;
      persistModel(arg);
      await ctx.reply(`Model: ${previous} → ${arg}`);
    } else {
      await ctx.reply(`Current model: ${config.copilotModel}`);
    }
  });
  bot.command("memory", async (ctx) => {
    const memories = searchMemories(undefined, undefined, 50);
    if (memories.length === 0) {
      await ctx.reply("No memories stored.");
    } else {
      const lines = memories.map((m) => `#${m.id} [${m.category}] ${m.content}`);
      await ctx.reply(lines.join("\n") + `\n\n${memories.length} total`);
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

  // Handle all text messages
  bot.on("message:text", async (ctx) => {
    const chatId = ctx.chat.id;
    const userMessageId = ctx.message.message_id;
    const replyParams = { message_id: userMessageId };

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
      ctx.message.text,
      { type: "telegram", chatId, messageId: userMessageId },
      (text: string, done: boolean) => {
        if (done) {
          stopTyping();
          // Send final message — use chunking for long responses, reply-quote original
          void (async () => {
            const formatted = toTelegramMarkdown(text);
            const chunks = chunkMessage(formatted);
            const fallbackChunks = chunkMessage(text);
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
      }
    );
  });

  return bot;
}

export async function startBot(): Promise<void> {
  if (!bot) throw new Error("Bot not created");
  console.log("[max] Telegram bot starting...");
  bot.start({
    onStart: () => console.log("[max] Telegram bot connected"),
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
  }
}
