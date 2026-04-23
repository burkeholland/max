import { getClient, stopClient } from "./copilot/client.js";
import { initOrchestrator, setMessageLogger, setProactiveNotify, getAgentInfo, shutdownAgents } from "./copilot/orchestrator.js";
import { startApiServer, broadcastToSSE } from "./api/server.js";
import { createBot, startBot, stopBot, sendProactiveMessage } from "./telegram/bot.js";
import { getDb, closeDb, getState } from "./store/db.js";
import { config } from "./config.js";
import { spawn } from "child_process";
import { readdirSync, statSync, rmSync } from "fs";
import { join } from "path";
import { checkForUpdate } from "./update.js";
import { ensureWikiStructure } from "./wiki/fs.js";
import { shouldMigrate, migrateMemoriesToWiki, shouldReorganize, reorganizeWiki } from "./wiki/migrate.js";
import { SESSIONS_DIR } from "./paths.js";

const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

/** Remove orphaned session folders older than 7 days, preserving the current session. */
function pruneOldSessions(): void {
  try {
    const sessionStateDir = join(SESSIONS_DIR, "session-state");
    const currentSessionId = getState("orchestrator_session_id");

    let entries: string[];
    try {
      entries = readdirSync(sessionStateDir);
    } catch {
      return; // directory may not exist yet
    }

    const cutoff = Date.now() - SEVEN_DAYS_MS;
    let pruned = 0;

    for (const entry of entries) {
      if (entry === currentSessionId) continue;

      const fullPath = join(sessionStateDir, entry);
      try {
        const stat = statSync(fullPath);
        if (stat.isDirectory() && stat.mtimeMs < cutoff) {
          rmSync(fullPath, { recursive: true, force: true });
          pruned++;
        }
      } catch {
        // skip entries we can't stat or remove
      }
    }

    if (pruned > 0) {
      console.log(`[max] Pruned ${pruned} orphaned session folder(s)`);
    }
  } catch (err) {
    console.error("[max] Session pruning failed (non-fatal):", err instanceof Error ? err.message : err);
  }
}

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

  // Initialize wiki knowledge base
  const wikiIsNew = ensureWikiStructure();
  if (wikiIsNew) {
    console.log("[max] Created wiki at ~/.max/wiki/");
  }
  if (shouldMigrate()) {
    console.log("[max] Migrating SQLite memories to wiki...");
    const count = migrateMemoriesToWiki();
    console.log(`[max] Migrated ${count} memories to wiki`);
  }
  if (shouldReorganize()) {
    console.log("[max] Reorganizing wiki pages into entity structure...");
    const count = reorganizeWiki();
    console.log(`[max] Created ${count} entity pages`);
  }

  // Prune orphaned session folders older than 7 days
  pruneOldSessions();

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
  } else if (!config.telegramBotToken && config.authorizedUserId === undefined) {
    console.log("[max] Telegram not configured — skipping bot. Run 'max setup' to configure.");
  } else if (!config.telegramBotToken) {
    console.log("[max] Telegram bot token missing — skipping bot. Run 'max setup' and enter your bot token.");
  } else {
    console.log("[max] Telegram user ID missing — skipping bot. Run 'max setup' and enter your Telegram user ID (get it from @userinfobot).");
  }

  console.log("[max] Max is fully operational.");

  // Non-blocking update check
  checkForUpdate()
    .then(({ updateAvailable, current, latest }) => {
      if (updateAvailable) {
        console.log(`[max] ⬆ Update available: v${current} → v${latest}  —  run 'max update' to install`);
      }
    })
    .catch(() => {});  // silent — network may be unavailable

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

  // Check for running workers before shutting down
  const workers = getAgentInfo();

  if (workers.length > 0 && shutdownState === "idle") {
    const names = workers.map(w => `@${w.slug}`).join(", ");
    console.log(`\n[max] ⚠ ${workers.length} running worker(s) will be stopped: ${names}`);
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

  // Destroy all active agent sessions
  await shutdownAgents();

  try { await stopClient(); } catch { /* best effort */ }
  closeDb();
  console.log("[max] Goodbye.");
  process.exit(0);
}

/** Restart the daemon by spawning a new process and exiting. */
export async function restartDaemon(): Promise<void> {
  console.log("[max] Restarting...");

  const workers = getAgentInfo();
  if (workers.length > 0) {
    console.log(`[max] ⚠ Stopping ${workers.length} running worker(s) for restart`);
  }

  if (config.telegramEnabled) {
    await sendProactiveMessage("Restarting — back in a sec ⏳").catch(() => {});
    try { await stopBot(); } catch { /* best effort */ }
  }

  // Destroy all active agent sessions
  await shutdownAgents();

  try { await stopClient(); } catch { /* best effort */ }
  closeDb();

  // In Docker, exit cleanly and let the container restart policy handle it.
  // Spawning a detached child won't work because PID 1 exiting kills the container.
  if (process.env.MAX_DOCKER === "1") {
    console.log("[max] Docker mode — exiting for container restart.");
    process.exit(0);
  }

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
  console.error("[max] Uncaught exception — shutting down:", err);
  process.exit(1);
});

main().catch((err) => {
  console.error("[max] Fatal error:", err);
  process.exit(1);
});
