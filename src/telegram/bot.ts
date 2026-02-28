import { Bot, type Context } from "grammy";
import { config } from "../config.js";
import { sendToOrchestrator } from "../copilot/orchestrator.js";
import { chunkMessage, toTelegramMarkdown } from "./formatter.js";

let bot: Bot | undefined;

export function createBot(): Bot {
  bot = new Bot(config.telegramBotToken);

  // Auth middleware — only allow the authorized user
  bot.use(async (ctx, next) => {
    if (ctx.from?.id !== config.authorizedUserId) {
      return; // Silently ignore unauthorized users
    }
    await next();
  });

  // /start and /help
  bot.command("start", (ctx) => ctx.reply("Max is online. Send me anything."));
  bot.command("help", (ctx) =>
    ctx.reply(
      "I'm Max, your AI orchestrator.\n\n" +
        "Just send me a message and I'll handle it.\n\n" +
        "Examples:\n" +
        '• "Start working on the auth bug in ~/dev/myapp"\n' +
        '• "What sessions are running?"\n' +
        '• "Check on the api-tests session"\n' +
        '• "Kill the auth-fix session"'
    )
  );

  // Handle all text messages
  bot.on("message:text", async (ctx) => {
    const chatId = ctx.chat.id;
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
      { type: "telegram", chatId },
      (text: string, done: boolean) => {
        if (done) {
          stopTyping();
          // Send final message — use chunking for long responses
          void (async () => {
            const formatted = toTelegramMarkdown(text);
            const chunks = chunkMessage(formatted);
            const fallbackChunks = chunkMessage(text);
            const sendChunk = async (chunk: string, fallback: string) => {
              await ctx.reply(chunk, { parse_mode: "MarkdownV2" }).catch(
                () => ctx.reply(fallback) // fallback to plain text if markdown fails
              );
            };
            try {
              // Streaming disabled: only send final assistant response
              for (let i = 0; i < chunks.length; i++) {
                await sendChunk(chunks[i], fallbackChunks[i] ?? chunks[i]);
              }
            } catch {
              // Last resort fallback
              try {
                for (const chunk of fallbackChunks) {
                  await ctx.reply(chunk);
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
  if (!bot) return;
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
  if (!bot) return;
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
