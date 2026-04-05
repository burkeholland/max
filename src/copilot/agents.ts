import { readdirSync, readFileSync, writeFileSync, mkdirSync, existsSync, rmSync } from "fs";
import { join } from "path";
import { AGENTS_DIR } from "../paths.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface AgentDefinition {
  /** Slug derived from filename (e.g. "coder" from "coder.agent.md") */
  slug: string;
  /** Display name from frontmatter */
  name: string;
  /** One-line description from frontmatter */
  description: string;
  /** Preferred model from frontmatter */
  model?: string;
  /** Tool list from frontmatter (Copilot CLI format) */
  tools?: string[];
  /** Full system message (markdown body below frontmatter) */
  systemMessage: string;
  /** Absolute path to the .agent.md file */
  filePath: string;
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

/** Parse a Copilot CLI .agent.md file into an AgentDefinition. */
function parseAgentMd(content: string, filePath: string, slug: string): AgentDefinition {
  const def: AgentDefinition = {
    slug,
    name: slug,
    description: "",
    systemMessage: "",
    filePath,
  };

  const fmMatch = content.match(/^---\n([\s\S]*?)\n---/);
  if (fmMatch) {
    const frontmatter = fmMatch[1];
    for (const line of frontmatter.split("\n")) {
      const idx = line.indexOf(": ");
      if (idx <= 0) continue;
      const key = line.slice(0, idx).trim();
      const value = line.slice(idx + 2).trim();

      switch (key) {
        case "name":
          def.name = value;
          break;
        case "description":
          def.description = value;
          break;
        case "model":
          def.model = value;
          break;
        case "tools":
          try {
            // Tools are a YAML array: ['tool1', 'tool2']
            def.tools = JSON.parse(value.replace(/'/g, '"'));
          } catch {
            // Fallback: comma-separated
            def.tools = value.replace(/[\[\]']/g, "").split(",").map((s) => s.trim()).filter(Boolean);
          }
          break;
      }
    }

    // Body is everything after the frontmatter
    def.systemMessage = content.slice(fmMatch[0].length).trim();
  } else {
    // No frontmatter — entire content is the system message
    def.systemMessage = content.trim();
  }

  return def;
}

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

let cachedAgents: AgentDefinition[] | undefined;

/** Scan ~/.max/agents/ and load all .agent.md files. */
export function loadAgents(): AgentDefinition[] {
  if (!existsSync(AGENTS_DIR)) {
    cachedAgents = [];
    return [];
  }

  const agents: AgentDefinition[] = [];
  let entries: string[];
  try {
    entries = readdirSync(AGENTS_DIR);
  } catch {
    cachedAgents = [];
    return [];
  }

  for (const entry of entries) {
    if (!entry.endsWith(".agent.md")) continue;
    const filePath = join(AGENTS_DIR, entry);
    const slug = entry.replace(/\.agent\.md$/, "").toLowerCase();

    try {
      const content = readFileSync(filePath, "utf-8");
      agents.push(parseAgentMd(content, filePath, slug));
    } catch {
      // Skip unreadable files
    }
  }

  cachedAgents = agents;
  return agents;
}

/** Get all loaded agent definitions (uses cache, call loadAgents() first). */
export function listAgentDefinitions(): AgentDefinition[] {
  return cachedAgents ?? loadAgents();
}

/** Look up an agent by name or slug (case-insensitive). */
export function getAgent(nameOrSlug: string): AgentDefinition | undefined {
  const lower = nameOrSlug.toLowerCase();
  const agents = listAgentDefinitions();
  return agents.find(
    (a) => a.slug === lower || a.name.toLowerCase() === lower,
  );
}

/** Invalidate the cached agent list (after hire/fire). */
export function invalidateAgentCache(): void {
  cachedAgents = undefined;
}

/** Build a formatted roster string for injection into the orchestrator system message. */
export function getAgentRoster(): string {
  const agents = listAgentDefinitions();
  if (agents.length === 0) return "";

  const lines = agents.map(
    (a) => `- **@${a.slug}**: ${a.description}${a.model ? ` (model: ${a.model})` : ""}`,
  );
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Agent lifecycle (hire / fire)
// ---------------------------------------------------------------------------

/** Create a new agent definition file. Returns the path on success. */
export function createAgentFile(
  slug: string,
  name: string,
  description: string,
  model: string,
  systemMessage: string,
): { ok: boolean; message: string } {
  // Validate slug
  if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(slug)) {
    return { ok: false, message: `Invalid slug '${slug}': use lowercase kebab-case (e.g. 'legal-expert').` };
  }

  mkdirSync(AGENTS_DIR, { recursive: true });
  const filePath = join(AGENTS_DIR, `${slug}.agent.md`);

  if (existsSync(filePath)) {
    return { ok: false, message: `Agent '${slug}' already exists at ${filePath}.` };
  }

  // Escape YAML values to prevent frontmatter injection
  const esc = (v: string) => `"${v.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n")}"`;
  const content = `---
name: ${esc(name)}
description: ${esc(description)}
model: ${esc(model)}
---

${systemMessage}
`;

  writeFileSync(filePath, content);
  invalidateAgentCache();
  return { ok: true, message: `Agent '${name}' created at ${filePath}. Available immediately.` };
}

/** Remove an agent definition file. */
export function removeAgentFile(slug: string): { ok: boolean; message: string } {
  const lower = slug.toLowerCase();
  // Validate slug with same strict regex as createAgentFile
  if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(lower)) {
    return { ok: false, message: `Invalid slug '${slug}': use lowercase kebab-case.` };
  }
  const filePath = join(AGENTS_DIR, `${lower}.agent.md`);
  if (!filePath.startsWith(AGENTS_DIR + "/")) {
    return { ok: false, message: `Invalid slug.` };
  }
  if (!existsSync(filePath)) {
    return { ok: false, message: `Agent '${slug}' not found in ${AGENTS_DIR}.` };
  }

  rmSync(filePath);

  // Clean up agent wiki if it exists
  const wikiDir = join(AGENTS_DIR, lower, "wiki");
  if (existsSync(wikiDir)) {
    rmSync(wikiDir, { recursive: true, force: true });
  }

  invalidateAgentCache();
  return { ok: true, message: `Agent '${slug}' removed.` };
}

// ---------------------------------------------------------------------------
// Per-agent wiki (simplified notes file)
// ---------------------------------------------------------------------------

function agentWikiDir(slug: string): string {
  return join(AGENTS_DIR, slug, "wiki");
}

function agentNotesPath(slug: string): string {
  return join(agentWikiDir(slug), "notes.md");
}

/** Append a note to an agent's wiki. */
export function agentRemember(slug: string, content: string): void {
  const dir = agentWikiDir(slug);
  mkdirSync(dir, { recursive: true });
  const notesPath = agentNotesPath(slug);
  const now = new Date().toISOString().slice(0, 10);
  const entry = `- ${content} _(${now})_\n`;

  if (existsSync(notesPath)) {
    const existing = readFileSync(notesPath, "utf-8");
    writeFileSync(notesPath, existing + entry);
  } else {
    writeFileSync(notesPath, `# ${slug} notes\n\n${entry}`);
  }
}

/** Search an agent's wiki notes. Returns matching lines or all notes if no query. */
export function agentRecall(slug: string, query?: string): string {
  const notesPath = agentNotesPath(slug);
  if (!existsSync(notesPath)) return "No notes yet.";

  const content = readFileSync(notesPath, "utf-8");
  if (!query) return content;

  const lower = query.toLowerCase();
  const lines = content.split("\n").filter(
    (line) => line.toLowerCase().includes(lower),
  );
  return lines.length > 0 ? lines.join("\n") : "No matching notes found.";
}

// ---------------------------------------------------------------------------
// Default agents (seeded on first run)
// ---------------------------------------------------------------------------

const DEFAULT_AGENTS: Array<{
  slug: string;
  name: string;
  description: string;
  model: string;
  systemMessage: string;
}> = [
  {
    slug: "coder",
    name: "Coder",
    description: "Writes code, fixes bugs, implements features, and debugs issues.",
    model: "claude-sonnet-4.6",
    systemMessage: `You are Coder, a specialist software engineer. You write clean, correct, well-structured code.

## Principles

1. Read existing code before changing it. Follow the patterns already established.
2. Prefer extending existing abstractions over creating new ones.
3. Keep functions small and focused. Pass state explicitly — avoid globals.
4. Write code that is obvious and easy to maintain, not clever.
5. Handle errors explicitly. Never silently swallow exceptions.
6. When fixing a bug, understand the root cause before writing the fix.

## Working Style

- You are thorough and methodical. You test your changes.
- You explain what you changed and why in plain language.
- If a task is ambiguous, ask for clarification rather than guessing.
- You can ask other agents for help using the ask_agent tool (e.g., ask the designer about UI requirements).`,
  },
  {
    slug: "designer",
    name: "Designer",
    description: "Handles UI/UX design, styling, layouts, and frontend aesthetics.",
    model: "claude-sonnet-4.6",
    systemMessage: `You are Designer, a specialist in UI/UX design and frontend development. You create beautiful, functional interfaces.

## Principles

1. User experience comes first. Every design decision should serve the user.
2. Accessibility is non-negotiable. Use semantic HTML, proper contrast, keyboard navigation.
3. Be intentional with every choice — typography, spacing, color, motion.
4. Prefer distinctive, memorable designs over generic templates.
5. Responsive design is the default, not an afterthought.

## Working Style

- You own the visual identity. You make design decisions confidently.
- You use the frontend-design skill when available.
- You explain your design rationale — why this font, why this layout.
- You can ask other agents for technical context using the ask_agent tool (e.g., ask the coder about framework constraints).`,
  },
  {
    slug: "researcher",
    name: "Researcher",
    description: "Deep analysis, documentation research, learning new topics, and strategic thinking.",
    model: "claude-sonnet-4.6",
    systemMessage: `You are Researcher, a specialist in deep analysis and knowledge synthesis. You explore topics thoroughly and present findings clearly.

## Principles

1. Go deep. Surface-level answers are not enough — find the real details.
2. Cite your sources. When referencing documentation, APIs, or articles, be specific.
3. Present findings in a structured, scannable format — headings, bullet points, comparisons.
4. Consider trade-offs. Every technology choice has pros and cons — present both sides.
5. Separate facts from opinions. Be clear about what is verified vs. what is your assessment.

## Working Style

- You are thorough and patient. You read the docs, explore the code, check multiple sources.
- You produce well-organized research documents.
- You can ask other agents for context using the ask_agent tool (e.g., ask the coder about the current tech stack).
- When asked to learn about something new, you create a comprehensive summary that others can reference.`,
  },
];

/** Create default agent definitions if ~/.max/agents/ is empty or missing. */
export function ensureDefaultAgents(): void {
  mkdirSync(AGENTS_DIR, { recursive: true });

  let entries: string[];
  try {
    entries = readdirSync(AGENTS_DIR).filter((e) => e.endsWith(".agent.md"));
  } catch {
    entries = [];
  }

  // Only seed if no agent files exist at all
  if (entries.length > 0) return;

  for (const agent of DEFAULT_AGENTS) {
    const filePath = join(AGENTS_DIR, `${agent.slug}.agent.md`);
    if (existsSync(filePath)) continue;

    const content = `---
name: ${agent.name}
description: ${agent.description}
model: ${agent.model}
---

${agent.systemMessage}
`;
    writeFileSync(filePath, content);
  }

  console.log(`[max] Seeded ${DEFAULT_AGENTS.length} default agents in ${AGENTS_DIR}`);
  invalidateAgentCache();
}
