// Channel-agnostic implementations of the slash commands shared by chat
// transports that don't have a richer per-channel UX (currently Feishu).
// The Telegram bot keeps its own command handlers because it has bespoke
// features (image replies, /models with chunking, /agents helpers, etc.).

import { config, persistModel } from "./config.js";
import { listSkills } from "./copilot/skills.js";
import {
  cancelCurrentMessage,
  getAgentInfo,
} from "./copilot/orchestrator.js";
import { getRouterConfig, updateRouterConfig } from "./copilot/router.js";
import { ensureWikiStructure } from "./wiki/fs.js";
import { parseIndex } from "./wiki/index-manager.js";

export const HELP_TEXT =
  "I'm Max, your AI daemon.\n\n" +
  "Just send me a message and I'll handle it.\n\n" +
  "Commands:\n" +
  "/cancel — Cancel the current message\n" +
  "/model — Show current model\n" +
  "/model <name> — Switch model\n" +
  "/models — List available models\n" +
  "/auto — Toggle auto model routing\n" +
  "/memory — Show wiki pages\n" +
  "/skills — List installed skills\n" +
  "/agents — List running agents\n" +
  "/workers — Alias for /agents\n" +
  "/restart — Restart Max\n" +
  "/help — Show this help";

export const START_TEXT = "Max is online. Send me anything.";

export async function handleCancel(sourceKey?: string): Promise<string> {
  const cancelled = await cancelCurrentMessage(sourceKey);
  return cancelled ? "⛔ Cancelled." : "Nothing to cancel.";
}

export async function handleModel(arg: string | undefined): Promise<string> {
  const trimmed = arg?.trim();
  if (!trimmed) {
    return `Current model: ${config.copilotModel}`;
  }
  // Validate against available models before persisting
  try {
    const { getClient } = await import("./copilot/client.js");
    const client = await getClient();
    const models = await client.listModels();
    const match = models.find((m) => m.id === trimmed);
    if (!match) {
      const suggestions = models
        .filter((m) => m.id.includes(trimmed) || m.id.toLowerCase().includes(trimmed.toLowerCase()))
        .map((m) => m.id);
      const hint = suggestions.length > 0 ? ` Did you mean: ${suggestions.join(", ")}?` : "";
      return `Model '${trimmed}' not found.${hint}`;
    }
  } catch {
    // If validation fails (client not ready), allow the switch — will fail on next message if wrong
  }
  const previous = config.copilotModel;
  config.copilotModel = trimmed;
  persistModel(trimmed);
  return `Model: ${previous} → ${trimmed}`;
}

export async function handleModels(): Promise<string> {
  try {
    const { getClient } = await import("./copilot/client.js");
    const client = await getClient();
    const models = await client.listModels();
    if (models.length === 0) {
      return "No models available.";
    }
    return models
      .map((m) => (m.id === config.copilotModel ? `• ${m.id} ← current` : `• ${m.id}`))
      .join("\n");
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return `Failed to list models: ${msg}`;
  }
}

export function handleMemory(): string {
  ensureWikiStructure();
  const entries = parseIndex();
  if (entries.length === 0) return "No wiki pages yet.";
  const lines = entries.map((e) => {
    let line = `• ${e.title}: ${e.summary}`;
    if (e.updated) line += ` (${e.updated})`;
    return line;
  });
  return lines.join("\n") + `\n\n${entries.length} wiki pages total`;
}

export function handleSkills(): string {
  const skills = listSkills();
  if (skills.length === 0) return "No skills installed.";
  return skills.map((s) => `• ${s.name} (${s.source}) — ${s.description}`).join("\n");
}

export function handleAgents(): string {
  const workers = getAgentInfo();
  if (workers.length === 0) return "No workers running.";
  return workers.map((w) => `🟢 @${w.slug} (${w.model}) — ${w.description}`).join("\n");
}

export function handleAuto(): string {
  const current = getRouterConfig();
  const newState = !current.enabled;
  updateRouterConfig({ enabled: newState });
  return newState ? "⚡ Auto mode on" : `Auto mode off · using ${config.copilotModel}`;
}
