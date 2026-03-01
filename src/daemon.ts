import { getClient, stopClient } from "./copilot/client.js";
import { initOrchestrator, setMessageLogger, setProactiveNotify, getWorkers } from "./copilot/orchestrator.js";
import { startApiServer, broadcastToSSE } from "./api/server.js";
import { createBot, startBot, stopBot, sendProactiveMessage } from "./telegram/bot.js";
import { getDb, closeDb } from "./store/db.js";
import { config } from "./config.js";
import { spawn } from "child_process";

function truncate(text: string, max = 200): string {
  const oneLine = text.replace(/\n/g, " ").trim();
  return oneLine.length > max ? oneLine.slice(0, max) + "…" : oneLine;
}

async function main(): Promise<void> {
  console.log("[max] Starting Max daemon...");
  if (config.selfEditEnabled) {
    console.log("[max] ⚠ Self-edit mode enabled — Max can modify his own source code");
  }

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

  // Wire up proactive notifications — route to the originating channel
  setProactiveNotify((text, channel) => {
    console.log(`[max] bg-notify (${channel ?? "all"}) ⟵  ${truncate(text)}`);
    if (!channel || channel === "telegram") {
      if (config.telegramEnabled) sendProactiveMessage(text);
    }
    if (!channel || channel === "tui") {
      broadcastToSSE(text);
    }
  });

  // Start HTTP API for TUI
  await startApiServer();

  // Start Telegram bot (if configured)
  if (config.telegramEnabled) {
    createBot();
    await startBot();
  } else {
    console.log("[max] Telegram not configured — skipping bot. Run 'max setup' to configure.");
  }

  console.log("[max] Max is fully operational.");

  // Notify user if this is a restart (not a fresh start)
  if (config.telegramEnabled && process.env.MAX_RESTARTED === "1") {
    await sendProactiveMessage("I'm back online 🟢").catch(() => {});
    delete process.env.MAX_RESTARTED;
  }
}

// Graceful shutdown
let shutdownState: "idle" | "warned" | "shutting_down" = "idle";
async function shutdown(): Promise<void> {
  if (shutdownState === "shutting_down") {
    console.log("\n[max] Forced exit.");
    process.exit(1);
  }

  // Check for active workers before shutting down
  const workers = getWorkers();
  const running = Array.from(workers.values()).filter(w => w.status === "running");

  if (running.length > 0 && shutdownState === "idle") {
    const names = running.map(w => w.name).join(", ");
    console.log(`\n[max] ⚠ ${running.length} active worker(s) will be destroyed: ${names}`);
    console.log("[max] Press Ctrl+C again to shut down, or wait for workers to finish.");
    shutdownState = "warned";
    return;
  }

  shutdownState = "shutting_down";
  console.log("\n[max] Shutting down... (Ctrl+C again to force)");

  // Force exit after 3 seconds no matter what
  const forceTimer = setTimeout(() => {
    console.log("[max] Shutdown timed out — forcing exit.");
    process.exit(1);
  }, 3000);
  forceTimer.unref();

  if (config.telegramEnabled) {
    try { await stopBot(); } catch { /* best effort */ }
  }

  // Destroy all active worker sessions to free memory
  await Promise.allSettled(
    Array.from(workers.values()).map((w) => w.session.destroy())
  );
  workers.clear();

  try { await stopClient(); } catch { /* best effort */ }
  closeDb();
  console.log("[max] Goodbye.");
  process.exit(0);
}

/** Restart the daemon by spawning a new process and exiting. */
export async function restartDaemon(): Promise<void> {
  console.log("[max] Restarting...");

  const activeWorkers = getWorkers();
  const runningCount = Array.from(activeWorkers.values()).filter(w => w.status === "running").length;
  if (runningCount > 0) {
    console.log(`[max] ⚠ Destroying ${runningCount} active worker(s) for restart`);
  }

  if (config.telegramEnabled) {
    await sendProactiveMessage("Restarting — back in a sec ⏳").catch(() => {});
    try { await stopBot(); } catch { /* best effort */ }
  }

  // Destroy all active worker sessions to free memory
  await Promise.allSettled(
    Array.from(activeWorkers.values()).map((w) => w.session.destroy())
  );
  activeWorkers.clear();

  try { await stopClient(); } catch { /* best effort */ }
  closeDb();

  // Spawn a detached replacement process with the same args (include execArgv for tsx/loaders)
  const child = spawn(process.execPath, [...process.execArgv, ...process.argv.slice(1)], {
    detached: true,
    stdio: "inherit",
    env: { ...process.env, MAX_RESTARTED: "1" },
  });
  child.unref();

  console.log("[max] New process spawned. Exiting old process.");
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
