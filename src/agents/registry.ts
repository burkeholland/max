import { readdirSync, readFileSync, existsSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { AGENTS_DIR } from "../paths.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface AgentConfig {
  slug: string;
  name: string;
  emoji: string;
  model: string;
  triggers: string[];
  skills: string[];
  systemPrompt: string;
  source: "builtin" | "user";
}

// ---------------------------------------------------------------------------
// Directories
// ---------------------------------------------------------------------------

/** User-local agents directory (~/.max/agents/) */
const USER_AGENTS_DIR = AGENTS_DIR;

/** Agents bundled with the Max package */
const BUNDLED_AGENTS_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "agents"
);

// ---------------------------------------------------------------------------
// Frontmatter parser (reuses the SKILL.md pattern)
// ---------------------------------------------------------------------------

interface AgentFrontmatter {
  name: string;
  emoji: string;
  model: string;
  triggers: string[];
  skills: string[];
}

function parseFrontmatter(content: string): { frontmatter: AgentFrontmatter; body: string } {
  const match = content.match(/^---\n([\s\S]*?)\n---/);
  if (!match) {
    return {
      frontmatter: { name: "", emoji: "", model: "", triggers: [], skills: [] },
      body: content.trim(),
    };
  }

  const raw = match[1];
  const body = content.slice(match[0].length).trim();

  let name = "";
  let emoji = "";
  let model = "";
  let triggers: string[] = [];
  let skills: string[] = [];

  for (const line of raw.split("\n")) {
    const idx = line.indexOf(": ");
    if (idx <= 0) continue;
    const key = line.slice(0, idx).trim();
    const value = line.slice(idx + 2).trim();
    switch (key) {
      case "name": name = value; break;
      case "emoji": emoji = value; break;
      case "model": model = value; break;
      case "triggers":
        triggers = value.split(",").map((t) => t.trim()).filter(Boolean);
        break;
      case "skills":
        skills = value.split(",").map((s) => s.trim()).filter(Boolean);
        break;
    }
  }

  return { frontmatter: { name, emoji, model, triggers, skills }, body };
}

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

let agentCache: Map<string, AgentConfig> | undefined;

function scanDirectory(dir: string, source: "builtin" | "user"): AgentConfig[] {
  if (!existsSync(dir)) return [];

  const agents: AgentConfig[] = [];
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return [];
  }

  for (const entry of entries) {
    const agentDir = join(dir, entry);
    const agentMd = join(agentDir, "AGENT.md");
    if (!existsSync(agentMd)) continue;

    try {
      const content = readFileSync(agentMd, "utf-8");
      const { frontmatter, body } = parseFrontmatter(content);
      agents.push({
        slug: entry,
        name: frontmatter.name || entry,
        emoji: frontmatter.emoji || "🤖",
        model: frontmatter.model || "",
        triggers: frontmatter.triggers,
        skills: frontmatter.skills,
        systemPrompt: body,
        source,
      });
    } catch {
      console.log(`[max] Could not parse agent config: ${agentMd}`);
    }
  }

  return agents;
}

/** Load all agent configs from disk. User agents override bundled agents with the same slug. */
export function loadAgents(): Map<string, AgentConfig> {
  const map = new Map<string, AgentConfig>();

  // Bundled agents first
  for (const agent of scanDirectory(BUNDLED_AGENTS_DIR, "builtin")) {
    map.set(agent.slug, agent);
  }

  // User agents override
  for (const agent of scanDirectory(USER_AGENTS_DIR, "user")) {
    map.set(agent.slug, agent);
  }

  agentCache = map;
  return map;
}

/** Get a specific agent by slug. Lazy-loads if not yet scanned. */
export function getAgent(slug: string): AgentConfig | undefined {
  if (!agentCache) loadAgents();
  return agentCache!.get(slug);
}

/** List all available agents. Lazy-loads if not yet scanned. */
export function listAgents(): AgentConfig[] {
  if (!agentCache) loadAgents();
  return Array.from(agentCache!.values());
}

/** Re-scan agent directories (e.g. after restart or /reload). */
export function reloadAgents(): Map<string, AgentConfig> {
  agentCache = undefined;
  return loadAgents();
}

/** Build a summary of available agents for injection into system prompts. */
export function getAgentSummary(): string {
  const agents = listAgents();
  if (agents.length === 0) return "";

  const lines = agents.map((a) => {
    const triggers = a.triggers.length > 0 ? ` (triggers: ${a.triggers.join(", ")})` : "";
    return `- ${a.emoji} **${a.name}** (\`@${a.slug}\`): ${a.systemPrompt.slice(0, 150).replace(/\n/g, " ")}…${triggers}`;
  });

  return lines.join("\n");
}
