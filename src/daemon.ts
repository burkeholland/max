import { getClient, stopClient } from "./copilot/client.js";
import { initOrchestrator, setMessageLogger, setProactiveNotify } from "./copilot/orchestrator.js";
import { startApiServer, broadcastToSSE } from "./api/server.js";
import { createBot, startBot, stopBot, sendProactiveMessage } from "./telegram/bot.js";
import { getDb, closeDb } from "./store/db.js";

function truncate(text: string, max = 200): string {
  const oneLine = text.replace(/\n/g, " ").trim();
  return oneLine.length > max ? oneLine.slice(0, max) + "…" : oneLine;
}

async function main(): Promise<void> {
  console.log("[max] Starting Max daemon...");

  // Set up message logging to daemon console
  setMessageLogger((direction, source, text) => {
    const arrow = direction === "in" ? "⟶" : "⟵";
    const tag = source.padEnd(8);
    console.log(`[max] ${tag} ${arrow}  ${truncate(text)}`);
  });

  // Initialize SQLite
  getDb();
  console.log("[max] Database initialized");

  // Start Copilot SDK client
  console.log("[max] Starting Copilot SDK client...");
  const client = await getClient();
  console.log("[max] Copilot SDK client ready");

  // Initialize orchestrator session
  console.log("[max] Creating orchestrator session...");
  await initOrchestrator(client);
  console.log("[max] Orchestrator session ready");

  // Wire up proactive notifications for background task completions
  setProactiveNotify((text) => {
    console.log(`[max] bg-notify ⟵  ${truncate(text)}`);
    sendProactiveMessage(text);
    broadcastToSSE(text);
  });

  // Start HTTP API for TUI
  await startApiServer();

  // Start Telegram bot
  createBot();
  await startBot();

  console.log("[max] Max is fully operational.");

  // Proactively notify the user that Max is back online
  await sendProactiveMessage("I'm back online 🟢").catch(() => {});
}

// Graceful shutdown
async function shutdown(): Promise<void> {
  console.log("\n[max] Shutting down...");
  // Notify user before going offline
  try {
    await sendProactiveMessage("Restarting — back in a sec ⏳");
  } catch {
    // Best effort
  }
  try {
    await stopBot();
  } catch {
    // Bot may not have started
  }
  try {
    await stopClient();
  } catch {
    // Client may not have started
  }
  closeDb();
  console.log("[max] Goodbye.");
  process.exit(0);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

// Prevent unhandled errors from crashing the daemon
process.on("unhandledRejection", (reason) => {
  console.error("[max] Unhandled rejection (kept alive):", reason);
});
process.on("uncaughtException", (err) => {
  console.error("[max] Uncaught exception (kept alive):", err.message);
});

main().catch((err) => {
  console.error("[max] Fatal error:", err);
  process.exit(1);
});
