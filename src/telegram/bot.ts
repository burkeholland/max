import { Bot, type Context } from "grammy";
import { config } from "../config.js";
import { sendToOrchestrator } from "../copilot/orchestrator.js";
import { chunkMessage } from "./formatter.js";

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
    let lastSentText = "";

    // Debounce streaming updates for Telegram (avoid rate limits)
    let updateTimer: ReturnType<typeof setTimeout> | undefined;
    let pendingText = "";
    let messageId: number | undefined;

    const flushUpdate = async () => {
      if (pendingText === lastSentText) return;
      const text = pendingText;
      lastSentText = text;

      try {
        if (!messageId) {
          const sent = await ctx.reply(text || "...");
          messageId = sent.message_id;
        } else {
          await ctx.api.editMessageText(chatId, messageId, text);
        }
      } catch {
        // Edit may fail if text hasn't changed or rate limited
      }
    };

    sendToOrchestrator(
      ctx.message.text,
      { type: "telegram", chatId },
      (text: string, done: boolean) => {
        pendingText = text;

        if (done) {
          if (updateTimer) clearTimeout(updateTimer);
          // Send final message — use chunking for long responses
          void (async () => {
            const chunks = chunkMessage(text);
            try {
              if (messageId && chunks.length === 1) {
                await ctx.api.editMessageText(chatId, messageId, chunks[0]);
              } else {
                if (messageId) {
                  try {
                    await ctx.api.deleteMessage(chatId, messageId);
                  } catch {
                    // May fail if message is too old
                  }
                }
                for (const chunk of chunks) {
                  await ctx.reply(chunk);
                }
              }
            } catch {
              // Fallback: send fresh chunks
              try {
                for (const chunk of chunks) {
                  await ctx.reply(chunk);
                }
              } catch {
                // Nothing more we can do
              }
            }
          })();
        } else {
          // Debounced streaming update (every 1.5s)
          if (!updateTimer) {
            updateTimer = setTimeout(() => {
              updateTimer = undefined;
              flushUpdate();
            }, 1500);
          }
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
