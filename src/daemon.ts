import { getClient, stopClient } from "./copilot/client.js";
import { initOrchestrator } from "./copilot/orchestrator.js";
import { startApiServer } from "./api/server.js";
import { createBot, startBot, stopBot } from "./telegram/bot.js";
import { getDb, closeDb } from "./store/db.js";

async function main(): Promise<void> {
  console.log("[max] Starting Max daemon...");

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

  // Start HTTP API for TUI
  await startApiServer();

  // Start Telegram bot
  createBot();
  await startBot();

  console.log("[max] Max is fully operational.");
}

// Graceful shutdown
async function shutdown(): Promise<void> {
  console.log("\n[max] Shutting down...");
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

main().catch((err) => {
  console.error("[max] Fatal error:", err);
  process.exit(1);
});
