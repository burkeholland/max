import { readdirSync, readFileSync, mkdirSync, writeFileSync, existsSync, rmSync, copyFileSync } from "fs";
import { createHash } from "crypto";
import { join, dirname, sep } from "path";
import { fileURLToPath } from "url";
import { z } from "zod";
import { approveAll, type CopilotClient, type CopilotSession, type Tool } from "@github/copilot-sdk";
import { AGENTS_DIR, SESSIONS_DIR } from "../paths.js";
import { getState, setState } from "../store/db.js";
import { loadMcpConfig } from "./mcp-config.js";
import { getSkillDirectories } from "./skills.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface AgentConfig {
  slug: string;
  name: string;
  description: string;
  model: string; // "auto" for dynamic model selection
  skills?: string[];
  tools?: string[]; // tool name allowlist; undefined = all execution tools
  mcpServers?: string[];
  systemMessage: string;
}

export interface AgentTaskInfo {
  taskId: string;
  agentSlug: string;
  description: string;
  status: "running" | "completed" | "error";
  result?: string;
  startedAt: number;
  completedAt?: number;
  originChannel?: string;
}

// Frontmatter schema
const agentFrontmatterSchema = z.object({
  name: z.string().min(1),
  description: z.string().min(1),
  model: z.string().min(1),
  skills: z.array(z.string()).optional(),
  tools: z.array(z.string()).optional(),
  mcpServers: z.array(z.string()).optional(),
});

// ---------------------------------------------------------------------------
// Agent Registry
// ---------------------------------------------------------------------------

let agentRegistry: AgentConfig[] = [];

/** Bundled agents shipped with the package */
const BUNDLED_AGENTS_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "agents"
);

const RESERVED_SLUGS = new Set(["max", "designer", "coder", "general-purpose"]);
const SLUG_REGEX = /^[a-z0-9]+(-[a-z0-9]+)*$/;

/** Parse YAML frontmatter and markdown body from an .agent.md file. */
export function parseAgentMd(content: string, slug: string): AgentConfig | null {
  const fmMatch = content.match(/^---\n([\s\S]*?)\n---\s*([\s\S]*)$/);
  if (!fmMatch) return null;

  const frontmatterRaw = fmMatch[1];
  const body = fmMatch[2].trim();

  // Simple YAML parser for flat + array values
  const parsed: Record<string, unknown> = {};
  for (const line of frontmatterRaw.split("\n")) {
    const idx = line.indexOf(": ");
    if (idx <= 0) continue;
    const key = line.slice(0, idx).trim();
    let value: unknown = line.slice(idx + 2).trim();

    // Handle YAML quoted strings
    if (typeof value === "string" && value.startsWith('"') && value.endsWith('"')) {
      value = value.slice(1, -1);
    }
    parsed[key] = value;
  }

  // Parse arrays from YAML inline syntax: [a, b, c]
  for (const key of ["skills", "tools", "mcpServers"]) {
    const raw = parsed[key];
    if (typeof raw === "string") {
      const arrMatch = raw.match(/^\[(.*)\]$/);
      if (arrMatch) {
        parsed[key] = arrMatch[1]
          .split(",")
          .map((s) => s.trim().replace(/^['"]|['"]$/g, ""))
          .filter(Boolean);
      }
    }
  }

  const result = agentFrontmatterSchema.safeParse(parsed);
  if (!result.success) {
    console.warn(`[agents] Invalid frontmatter in ${slug}.agent.md:`, result.error.format());
    return null;
  }

  const fm = result.data;
  return {
    slug,
    name: fm.name,
    description: fm.description,
    model: fm.model,
    skills: fm.skills,
    tools: fm.tools,
    mcpServers: fm.mcpServers,
    systemMessage: body,
  };
}

/** Scan ~/.max/agents/ for .agent.md files and load configs. */
export function loadAgents(): AgentConfig[] {
  if (!existsSync(AGENTS_DIR)) {
    mkdirSync(AGENTS_DIR, { recursive: true });
    return [];
  }

  const configs: AgentConfig[] = [];
  let entries: string[];
  try {
    entries = readdirSync(AGENTS_DIR);
  } catch {
    return [];
  }

  for (const entry of entries) {
    if (!entry.endsWith(".agent.md")) continue;
    const slug = entry.replace(/\.agent\.md$/, "");
    try {
      const content = readFileSync(join(AGENTS_DIR, entry), "utf-8");
      const config = parseAgentMd(content, slug);
      if (config) configs.push(config);
    } catch (err) {
      console.warn(`[agents] Failed to read ${entry}:`, err instanceof Error ? err.message : err);
    }
  }

  agentRegistry = configs;
  return configs;
}

/** Get agent config by name or slug (case-insensitive). */
export function getAgent(nameOrSlug: string): AgentConfig | undefined {
  const lower = nameOrSlug.toLowerCase();
  return agentRegistry.find(
    (a) => a.slug === lower || a.name.toLowerCase() === lower
  );
}

/** Get all loaded agent configs. */
export function getAgentRegistry(): AgentConfig[] {
  return [...agentRegistry];
}

/** Copy bundled agents to ~/.max/agents/, updating stale copies when the bundled version changes.
 *  Respects user customizations: if the user edited the deployed file after our last sync, we skip it. */
export function ensureDefaultAgents(): void {
  mkdirSync(AGENTS_DIR, { recursive: true });

  if (!existsSync(BUNDLED_AGENTS_DIR)) return;

  let bundled: string[];
  try {
    bundled = readdirSync(BUNDLED_AGENTS_DIR).filter((f) => f.endsWith(".agent.md"));
  } catch {
    return;
  }

  for (const file of bundled) {
    const src = join(BUNDLED_AGENTS_DIR, file);
    const dest = join(AGENTS_DIR, file);
    const srcHash = createHash("sha256").update(readFileSync(src)).digest("hex");
    const stateKey = `bundled_agent_hash:${file}`;

    if (!existsSync(dest)) {
      copyFileSync(src, dest);
      setState(stateKey, srcHash);
      console.log(`[agents] Installed bundled agent: ${file}`);
      continue;
    }

    // Check if the bundled version actually changed since our last sync
    const lastSyncedHash = getState(stateKey);
    if (lastSyncedHash === srcHash) continue; // bundled hasn't changed

    // Bundled version changed — only overwrite if the user hasn't customized it.
    // If we have a record of what we last deployed, check if the file still matches.
    const destHash = createHash("sha256").update(readFileSync(dest)).digest("hex");
    if (lastSyncedHash && destHash !== lastSyncedHash) {
      // User modified the file after our last sync — don't clobber their changes
      console.log(`[agents] Skipping ${file} — user has local customizations`);
      continue;
    }

    // Safe to update: either first sync (no record) or file is unmodified from our last deploy
    copyFileSync(src, dest);
    setState(stateKey, srcHash);
    console.log(`[agents] Updated bundled agent: ${file}`);
  }
}

/** Create a new agent .md file. Returns error string or null on success. */
export function createAgentFile(
  slug: string,
  name: string,
  description: string,
  model: string,
  systemPrompt: string,
  skills?: string[],
  tools?: string[]
): string | null {
  if (!SLUG_REGEX.test(slug)) {
    return `Invalid slug '${slug}': must be kebab-case (a-z0-9 with hyphens).`;
  }
  const filePath = join(AGENTS_DIR, `${slug}.agent.md`);
  if (!filePath.startsWith(AGENTS_DIR + sep)) {
    return `Invalid slug '${slug}': path traversal detected.`;
  }
  if (existsSync(filePath)) {
    return `Agent '${slug}' already exists. Edit it directly or remove it first.`;
  }

  // YAML value escaping for safe frontmatter
  const escapedName = name.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n");
  const escapedDesc = description.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n");

  let frontmatter = `---\nname: "${escapedName}"\ndescription: "${escapedDesc}"\nmodel: ${model}`;
  if (skills?.length) frontmatter += `\nskills:\n${skills.map((s) => `  - ${s}`).join("\n")}`;
  if (tools?.length) frontmatter += `\ntools:\n${tools.map((t) => `  - ${t}`).join("\n")}`;
  frontmatter += "\n---\n\n";

  writeFileSync(filePath, frontmatter + systemPrompt + "\n");
  return null;
}

/** Remove an agent .md file. Returns error string or null on success. */
export function removeAgentFile(slug: string): string | null {
  if (!SLUG_REGEX.test(slug)) {
    return `Invalid slug '${slug}'.`;
  }
  if (RESERVED_SLUGS.has(slug)) {
    return `Cannot remove built-in agent '${slug}'. You can edit its file instead.`;
  }
  const filePath = join(AGENTS_DIR, `${slug}.agent.md`);
  if (!filePath.startsWith(AGENTS_DIR + sep)) {
    return `Invalid slug '${slug}': path traversal detected.`;
  }
  if (!existsSync(filePath)) {
    return `Agent '${slug}' not found.`;
  }
  rmSync(filePath);
  return null;
}

// ---------------------------------------------------------------------------
// Agent Session Management
// ---------------------------------------------------------------------------

// Per-agent task tracking (in-memory, backed by DB)
const activeTasks = new Map<string, AgentTaskInfo>();
let taskCounter = 0;

function nextTaskId(): string {
  return `task-${++taskCounter}-${Date.now().toString(36)}`;
}

/** Shared base prompt injected into all agent sessions. */
function getAgentBasePrompt(): string {
  return `## Runtime Context

You are an agent within Max, a personal AI assistant for developers. You run on the user's local machine.

### Shared Wiki
All agents share a wiki knowledge base for persistent memory. Use \`wiki_read\` and \`wiki_search\` to find existing knowledge, and \`wiki_update\` to save important findings.

### Communication
- You receive tasks from @max (the orchestrator) or directly from the user
- Your results are relayed back to the user by @max
- To share knowledge with other agents, write to the wiki

### Guidelines
- Be thorough but concise in your responses
- Use the wiki to check for existing context before starting work
- Save important findings to the wiki for other agents to use
`;
}

/** Build the full system message for an agent. */
export function composeAgentSystemMessage(agent: AgentConfig, rosterInfo?: string): string {
  const base = getAgentBasePrompt();
  const agentPrompt = agent.systemMessage;

  // For @max, inject the agent roster
  if (agent.slug === "max" && rosterInfo) {
    return agentPrompt.replace("{agent_roster}", rosterInfo);
  }

  return `${agentPrompt}\n\n${base}`;
}

/** Build a roster description of all agents for @max's system prompt. */
export function buildAgentRoster(): string {
  const agents = getAgentRegistry();
  if (agents.length === 0) return "No agents registered.";

  return agents
    .filter((a) => a.slug !== "max")
    .map((a) => {
      const model = a.model === "auto" ? "dynamic (you choose)" : a.model;
      const skills = a.skills?.length ? ` | skills: ${a.skills.join(", ")}` : "";
      return `- **@${a.slug}** — ${a.description} (model: ${model}${skills})`;
    })
    .join("\n");
}

// The wiki tools that every agent gets regardless of tool config
const WIKI_TOOL_NAMES = new Set([
  "wiki_search", "wiki_read", "wiki_update", "remember", "recall", "forget",
  "wiki_ingest", "wiki_lint", "wiki_rebuild_index",
]);

// Management tools that only @max should have
const MANAGEMENT_TOOL_NAMES = new Set([
  "delegate_to_agent", "check_agent_status", "get_agent_result",
  "show_agent_roster", "hire_agent", "fire_agent",
  "switch_model", "toggle_auto", "list_models",
  "restart_max", "list_skills", "learn_skill", "uninstall_skill",
  "list_machine_sessions", "attach_machine_session",
]);

/** Filter tools based on agent config. */
export function filterToolsForAgent(agent: AgentConfig, allTools: Tool<any>[]): Tool<any>[] {
  if (agent.tools && agent.tools.length > 0) {
    // Agent specifies an explicit allowlist — give those + wiki tools
    const allowed = new Set([...agent.tools, ...WIKI_TOOL_NAMES]);
    return allTools.filter((t) => allowed.has(t.name));
  }

  // Default: all tools except management (only @max gets those)
  if (agent.slug === "max") {
    return allTools;
  }
  return allTools.filter((t) => !MANAGEMENT_TOOL_NAMES.has(t.name));
}

/** Create an ephemeral session for an agent. Always creates a fresh session — caller is responsible for destroying it. */
export async function createEphemeralAgentSession(
  slug: string,
  client: CopilotClient,
  allTools: Tool<any>[],
  modelOverride?: string
): Promise<CopilotSession> {
  const agent = getAgent(slug);
  if (!agent) throw new Error(`Agent '${slug}' not found in registry.`);

  // Explicit override always wins. Otherwise use frontmatter model (with
  // fallback to sonnet for "auto" agents that receive no override).
  const model = (modelOverride && modelOverride.length > 0)
    ? modelOverride
    : (agent.model === "auto" ? "claude-sonnet-4.6" : agent.model);
  const tools = filterToolsForAgent(agent, allTools);
  const mcpServers = loadMcpConfig();
  const skillDirectories = getSkillDirectories();

  const session = await client.createSession({
    model,
    configDir: SESSIONS_DIR,
    workingDirectory: process.cwd(),
    streaming: true,
    systemMessage: { content: composeAgentSystemMessage(agent) },
    tools,
    mcpServers,
    skillDirectories,
    onPermissionRequest: approveAll,
    infiniteSessions: {
      enabled: true,
      backgroundCompactionThreshold: 0.80,
      bufferExhaustionThreshold: 0.95,
    },
  });

  console.log(`[agents] Created ephemeral session for @${agent.slug} (${model})`);
  return session;
}

/** Clean up active task tracking (for shutdown/restart). */
export async function clearActiveTasks(): Promise<void> {
  activeTasks.clear();
}

/** Get status info for an agent (task info only — no persistent sessions). */
export function getAgentSessionStatus(slug: string): {
  taskCount: number;
  tasks: AgentTaskInfo[];
} {
  const tasks = Array.from(activeTasks.values()).filter((t) => t.agentSlug === slug);
  return {
    taskCount: tasks.length,
    tasks,
  };
}

/** Get all active tasks. */
export function getActiveTasks(): AgentTaskInfo[] {
  return Array.from(activeTasks.values());
}

/** Get a task by ID. */
export function getTask(taskId: string): AgentTaskInfo | undefined {
  return activeTasks.get(taskId);
}

/** Register a new task. */
export function registerTask(
  agentSlug: string,
  description: string,
  originChannel?: string
): AgentTaskInfo {
  const task: AgentTaskInfo = {
    taskId: nextTaskId(),
    agentSlug,
    description,
    status: "running",
    startedAt: Date.now(),
    originChannel,
  };
  activeTasks.set(task.taskId, task);
  return task;
}

/** Mark a task as completed. */
export function completeTask(taskId: string, result: string): void {
  const task = activeTasks.get(taskId);
  if (task) {
    task.status = "completed";
    task.result = result;
    task.completedAt = Date.now();
  }
}

/** Mark a task as failed. */
export function failTask(taskId: string, error: string): void {
  const task = activeTasks.get(taskId);
  if (task) {
    task.status = "error";
    task.result = error;
    task.completedAt = Date.now();
  }
}

// ---------------------------------------------------------------------------
// @mention routing
// ---------------------------------------------------------------------------

/** Active agent per conversation channel (sticky routing). */
const activeAgentByChannel = new Map<string, string>();

/** Get the active agent for a channel. Returns "max" if none set. */
export function getActiveAgent(channel: string): string {
  return activeAgentByChannel.get(channel) || "max";
}

/** Set the active agent for a channel. */
export function setActiveAgent(channel: string, slug: string): void {
  activeAgentByChannel.set(channel, slug);
}

/** Parse @mention from message text. Returns agent slug and remaining message, or null. */
export function parseAtMention(text: string): { agentSlug: string; message: string } | null {
  const match = text.match(/^@([a-zA-Z0-9-]+)\s*([\s\S]*)$/);
  if (!match) return null;

  const mentionedName = match[1].toLowerCase();
  const message = match[2].trim();

  // Check if this matches a registered agent
  const agent = getAgent(mentionedName);
  if (!agent) return null;

  return { agentSlug: agent.slug, message: message || "" };
}
