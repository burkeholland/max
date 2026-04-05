import express from "express";
import type { Request, Response, NextFunction } from "express";
import { readFileSync, writeFileSync, existsSync } from "fs";
import { randomBytes } from "crypto";
import { sendToOrchestrator, getWorkers, cancelCurrentMessage, getLastRouteResult, getActiveAgent } from "../copilot/orchestrator.js";
import { sendPhoto } from "../telegram/bot.js";
import { config, persistModel } from "../config.js";
import { getRouterConfig, updateRouterConfig } from "../copilot/router.js";
import { searchMemories } from "../store/db.js";
import { listSkills, removeSkill } from "../copilot/skills.js";
import { listAgentDefinitions } from "../copilot/agents.js";
import { restartDaemon } from "../daemon.js";
import { API_TOKEN_PATH, ensureMaxHome } from "../paths.js";

// Ensure token file exists (generate on first run)
let apiToken: string | null = null;
try {
  if (existsSync(API_TOKEN_PATH)) {
    apiToken = readFileSync(API_TOKEN_PATH, "utf-8").trim();
  } else {
    ensureMaxHome();
    apiToken = randomBytes(32).toString("hex");
    writeFileSync(API_TOKEN_PATH, apiToken, { mode: 0o600 });
  }
} catch (err) {
  console.error(`[auth] Failed to load/generate API token: ${err}`);
  process.exit(1);
}

const app = express();
app.use(express.json());

// Bearer token authentication middleware (skip /status health check)
app.use((req: Request, res: Response, next: NextFunction) => {
  if (!apiToken || req.path === "/status") return next();
  const auth = req.headers.authorization;
  if (!auth || auth !== `Bearer ${apiToken}`) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  next();
});

// Active SSE connections
const sseClients = new Map<string, Response>();
let connectionCounter = 0;

// Health check — intentionally unauthenticated, returns no sensitive data
app.get("/status", (_req: Request, res: Response) => {
  res.json({
    status: "ok",
    workers: Array.from(getWorkers().values()).map((w) => ({
      name: w.name,
      status: w.status,
    })),
  });
});

// List worker sessions
app.get("/sessions", (_req: Request, res: Response) => {
  const workers = Array.from(getWorkers().values()).map((w) => ({
    name: w.name,
    workingDir: w.workingDir,
    status: w.status,
    lastOutput: w.lastOutput?.slice(0, 500),
  }));
  res.json(workers);
});

// SSE stream for real-time responses
app.get("/stream", (req: Request, res: Response) => {
  const connectionId = `tui-${++connectionCounter}`;

  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });
  res.write(`data: ${JSON.stringify({ type: "connected", connectionId })}\n\n`);

  sseClients.set(connectionId, res);

  // Heartbeat to keep connection alive
  const heartbeat = setInterval(() => {
    res.write(`:ping\n\n`);
  }, 20_000);

  req.on("close", () => {
    clearInterval(heartbeat);
    sseClients.delete(connectionId);
  });
});

// Send a message to the orchestrator
app.post("/message", (req: Request, res: Response) => {
  const { prompt, connectionId } = req.body as { prompt?: string; connectionId?: string };

  if (!prompt || typeof prompt !== "string") {
    res.status(400).json({ error: "Missing 'prompt' in request body" });
    return;
  }

  if (!connectionId || !sseClients.has(connectionId)) {
    res.status(400).json({ error: "Missing or invalid 'connectionId'. Connect to /stream first." });
    return;
  }

  sendToOrchestrator(
    prompt,
    { type: "tui", connectionId },
    (text: string, done: boolean) => {
      const sseRes = sseClients.get(connectionId);
      if (sseRes) {
        const event: Record<string, unknown> = {
          type: done ? "message" : "delta",
          content: text,
        };
        if (done) {
          const routeResult = getLastRouteResult();
          if (routeResult) {
            event.route = {
              model: routeResult.model,
              routerMode: routeResult.routerMode,
              tier: routeResult.tier,
              ...(routeResult.overrideName ? { overrideName: routeResult.overrideName } : {}),
            };
          }
          // Include active agent info for TUI prompt updates
          const activeAgent = getActiveAgent("tui");
          if (activeAgent) {
            event.activeAgent = activeAgent;
          }
        }
        sseRes.write(`data: ${JSON.stringify(event)}\n\n`);
      }
    }
  );

  res.json({ status: "queued" });
});

// Cancel the current in-flight message
app.post("/cancel", async (_req: Request, res: Response) => {
  const cancelled = await cancelCurrentMessage();
  // Notify all SSE clients that the message was cancelled
  for (const [, sseRes] of sseClients) {
    sseRes.write(
      `data: ${JSON.stringify({ type: "cancelled" })}\n\n`
    );
  }
  res.json({ status: "ok", cancelled });
});

// Get or switch model
app.get("/model", (_req: Request, res: Response) => {
  res.json({ model: config.copilotModel });
});
app.post("/model", async (req: Request, res: Response) => {
  const { model } = req.body as { model?: string };
  if (!model || typeof model !== "string") {
    res.status(400).json({ error: "Missing 'model' in request body" });
    return;
  }
  // Validate against available models before persisting
  try {
    const { getClient } = await import("../copilot/client.js");
    const client = await getClient();
    const models = await client.listModels();
    const match = models.find((m) => m.id === model);
    if (!match) {
      const suggestions = models
        .filter((m) => m.id.includes(model) || m.id.toLowerCase().includes(model.toLowerCase()))
        .map((m) => m.id);
      const hint = suggestions.length > 0 ? ` Did you mean: ${suggestions.join(", ")}?` : "";
      res.status(400).json({ error: `Model '${model}' not found.${hint}` });
      return;
    }
  } catch {
    // If we can't validate (client not ready), allow the switch — it'll fail on next message if wrong
  }
  const previous = config.copilotModel;
  config.copilotModel = model;
  persistModel(model);
  res.json({ previous, current: model });
});

// List all available models
app.get("/models", async (_req: Request, res: Response) => {
  try {
    const { getClient } = await import("../copilot/client.js");
    const client = await getClient();
    const models = await client.listModels();
    res.json({ models: models.map((m) => m.id), current: config.copilotModel });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: `Failed to list models: ${msg}` });
  }
});

// Get auto-routing config
app.get("/auto", (_req: Request, res: Response) => {
  const routerConfig = getRouterConfig();
  const lastRoute = getLastRouteResult();
  res.json({
    ...routerConfig,
    currentModel: config.copilotModel,
    lastRoute: lastRoute || null,
  });
});

// Update auto-routing config
app.post("/auto", (req: Request, res: Response) => {
  const body = req.body as Partial<{
    enabled: boolean;
    tierModels: Record<string, string>;
    cooldownMessages: number;
  }>;

  const updated = updateRouterConfig(body);
  console.log(`[max] Auto-routing ${updated.enabled ? "enabled" : "disabled"}`);

  res.json(updated);
});

// List memories
app.get("/memory", (_req: Request, res: Response) => {
  const memories = searchMemories(undefined, undefined, 100);
  res.json(memories);
});

// List skills
app.get("/skills", (_req: Request, res: Response) => {
  const skills = listSkills();
  res.json(skills);
});

// Remove a local skill
app.delete("/skills/:slug", (req: Request, res: Response) => {
  const slug = Array.isArray(req.params.slug) ? req.params.slug[0] : req.params.slug;
  const result = removeSkill(slug);
  if (!result.ok) {
    res.status(400).json({ error: result.message });
  } else {
    res.json({ ok: true, message: result.message });
  }
});

// List agents
app.get("/agents", (_req: Request, res: Response) => {
  const agents = listAgentDefinitions().map((a) => ({
    slug: a.slug,
    name: a.name,
    description: a.description,
    model: a.model,
  }));
  const activeAgent = getActiveAgent("tui");
  res.json({ agents, activeAgent });
});

// Restart daemon
app.post("/restart", (_req: Request, res: Response) => {
  res.json({ status: "restarting" });
  setTimeout(() => {
    restartDaemon().catch((err) => {
      console.error("[max] Restart failed:", err);
    });
  }, 500);
});

// Send a photo to Telegram
app.post("/send-photo", async (req: Request, res: Response) => {
  const { photo, caption } = req.body as { photo?: string; caption?: string };

  if (!photo || typeof photo !== "string") {
    res.status(400).json({ error: "Missing 'photo' (file path or URL) in request body" });
    return;
  }

  // Restrict local file paths to the system temp directory to prevent arbitrary file exfiltration
  if (!photo.startsWith("http://") && !photo.startsWith("https://")) {
    const { resolve } = await import("path");
    const { tmpdir } = await import("os");
    const resolvedPhoto = resolve(photo);
    const allowedBase = resolve(tmpdir());
    if (!resolvedPhoto.startsWith(allowedBase + "/") && resolvedPhoto !== allowedBase) {
      res.status(403).json({ error: "Local file paths must be within the system temp directory. Use a URL or save the file to the temp dir first." });
      return;
    }
  }

  try {
    await sendPhoto(photo, caption);
    res.json({ status: "sent" });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: msg });
  }
});

export function startApiServer(): Promise<void> {
  return new Promise((resolve, reject) => {
    const server = app.listen(config.apiPort, "127.0.0.1", () => {
      console.log(`[max] HTTP API listening on http://127.0.0.1:${config.apiPort}`);
      resolve();
    });
    server.on("error", (err: NodeJS.ErrnoException) => {
      if (err.code === "EADDRINUSE") {
        reject(new Error(`Port ${config.apiPort} is already in use. Is another Max instance running?`));
      } else {
        reject(err);
      }
    });
  });
}

/** Broadcast a proactive message to all connected SSE clients (for background task completions). */
export function broadcastToSSE(text: string): void {
  for (const [, res] of sseClients) {
    res.write(
      `data: ${JSON.stringify({ type: "message", content: text })}\n\n`
    );
  }
}
