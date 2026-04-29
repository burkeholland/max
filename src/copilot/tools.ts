import { z } from "zod";
import { approveAll, defineTool, type CopilotClient, type CopilotSession, type Tool } from "@github/copilot-sdk";
import { getDb } from "../store/db.js";
import { readdirSync, readFileSync, statSync } from "fs";
import { join, sep, resolve } from "path";
import { homedir } from "os";
import { listSkills, createSkill, removeSkill } from "./skills.js";
import { config, persistModel } from "../config.js";
import { SESSIONS_DIR } from "../paths.js";
import { getCurrentSourceKey, switchSessionModel } from "./orchestrator.js";
import { getRouterConfig, updateRouterConfig } from "./router.js";
import { ensureWikiStructure, readPage, writePage, deletePage, listPages, writeRawSource, listSources, getWikiDir, assertPagePath } from "../wiki/fs.js";
import { searchIndex, addToIndex, removeFromIndex, parseIndex, buildIndexEntryForPage, type IndexEntry } from "../wiki/index-manager.js";
import { appendLog } from "../wiki/log-manager.js";
import { withWikiWrite } from "../wiki/lock.js";
import {
  getAgentRegistry, getAgent, createEphemeralAgentSession, getAgentSessionStatus,
  getActiveTasks, getTask, registerTask, completeTask, failTask,
  createAgentFile, removeAgentFile, loadAgents,
  type AgentConfig, type AgentTaskInfo,
} from "./agents.js";

function getCategoryDir(category: string): string {
  const map: Record<string, string> = {
    person: "people",
    project: "projects",
    preference: "preferences",
    fact: "facts",
    routine: "routines",
    decision: "decisions",
  };
  return map[category] || category;
}

/** Escape a string for safe inclusion as a single-line YAML scalar value. */
function yamlEscape(value: string): string {
  // Always quote and escape backslashes, double quotes, and newlines.
  const escaped = value
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\n/g, "\\n")
    .replace(/\r/g, "\\r");
  return `"${escaped}"`;
}

/** Escape a single token for use inside a YAML inline list `[a, b]`. */
function yamlListItem(value: string): string {
  // Restrict to a safe character set; replace anything else.
  const safe = value.replace(/[^A-Za-z0-9_./-]/g, "-");
  return safe || "untagged";
}

/** Sanitize a single line for safe inclusion as an index/log table entry. */
function indexSafe(text: string): string {
  return text.replace(/[\r\n|]/g, " ").trim();
}

function isTimeoutError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /timeout|timed?\s*out/i.test(msg);
}

export interface ToolDeps {
  client: CopilotClient;
  onAgentTaskComplete: (taskId: string, agentSlug: string, result: string) => void;
}

export function createTools(deps: ToolDeps): Tool<any>[] {
  return [
    // ----- Agent Delegation Tools (for @max) -----

    defineTool("delegate_to_agent", {
      description:
        "Delegate a task to a specialist agent. The task runs in the background — you'll be notified when it's done. " +
        "Available agents: use show_agent_roster to see the roster. For @general-purpose, specify model_override based on task complexity.",
      parameters: z.object({
        agent_name: z.string().describe("Name or slug of the agent to delegate to (e.g. 'coder', 'designer', 'general-purpose')"),
        task: z.string().describe("Detailed task description for the agent"),
        summary: z.string().describe("Short human-readable summary of the task (under 80 chars, e.g. 'Fix login button styling')"),
        model_override: z.string().optional().describe("Model override for agents with model 'auto' (e.g. 'gpt-4.1', 'claude-sonnet-4.6', 'claude-opus-4.6')"),
      }),
      handler: async (args) => {
        const agent = getAgent(args.agent_name);
        if (!agent) {
          const available = getAgentRegistry().map((a) => a.slug).join(", ");
          return `Agent '${args.agent_name}' not found. Available agents: ${available}`;
        }
        if (agent.slug === "max") {
          return "Cannot delegate to yourself. Handle this directly or pick a specialist agent.";
        }

        let session: CopilotSession;
        try {
          // Get all tools so we can filter for this agent
          const allTools = createTools(deps);
          session = await createEphemeralAgentSession(agent.slug, deps.client, allTools, args.model_override);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          return `Failed to create session for @${agent.slug}: ${msg}`;
        }

        const task = registerTask(agent.slug, args.summary, getCurrentSourceKey());

        // Persist task to DB
        const db = getDb();
        db.prepare(
          `INSERT INTO agent_tasks (task_id, agent_slug, description, status, origin_channel) VALUES (?, ?, ?, 'running', ?)`
        ).run(task.taskId, agent.slug, args.summary, task.originChannel || null);

        const timeoutMs = config.workerTimeoutMs;
        // Non-blocking: dispatch and return immediately. Session is always destroyed after.
        (async () => {
          try {
            const result = await session.sendAndWait({ prompt: args.task }, timeoutMs);
            const output = result?.data?.content || "No response";
            completeTask(task.taskId, output);
            db.prepare(`UPDATE agent_tasks SET status = 'completed', result = ?, completed_at = CURRENT_TIMESTAMP WHERE task_id = ?`).run(output.slice(0, 10000), task.taskId);
            deps.onAgentTaskComplete(task.taskId, agent.slug, output);
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            failTask(task.taskId, msg);
            db.prepare(`UPDATE agent_tasks SET status = 'error', result = ?, completed_at = CURRENT_TIMESTAMP WHERE task_id = ?`).run(msg, task.taskId);
            deps.onAgentTaskComplete(task.taskId, agent.slug, `Error: ${msg}`);
          } finally {
            session.destroy().catch(() => {});
          }
        })();

        const model = (args.model_override && args.model_override.length > 0)
          ? args.model_override
          : (agent.model === "auto" ? "claude-sonnet-4.6" : agent.model);
        return `Task delegated to @${agent.slug} (${model}). Task ID: ${task.taskId}. I'll notify you when it's done.`;
      },
    }),

    defineTool("check_agent_status", {
      description: "Check the status of an agent or a specific delegated task.",
      parameters: z.object({
        agent_name: z.string().optional().describe("Agent name/slug to check"),
        task_id: z.string().optional().describe("Specific task ID to check"),
      }),
      handler: async (args) => {
        if (args.task_id) {
          const task = getTask(args.task_id);
          if (!task) return `Task '${args.task_id}' not found.`;
          const elapsed = Math.round((Date.now() - task.startedAt) / 1000);
          let info = `Task ${task.taskId} (@${task.agentSlug})\nStatus: ${task.status}\nDescription: ${task.description}\nElapsed: ${elapsed}s`;
          if (task.result) info += `\n\nResult:\n${task.result.slice(0, 2000)}`;
          return info;
        }

        if (args.agent_name) {
          const agent = getAgent(args.agent_name);
          if (!agent) return `Agent '${args.agent_name}' not found.`;
          const status = getAgentSessionStatus(agent.slug);
          let info = `@${agent.slug} (${agent.name})\nModel: ${agent.model}`;
          if (status.tasks.length > 0) {
            info += `\n\nActive tasks (${status.tasks.length}):`;
            for (const t of status.tasks) {
              info += `\n• ${t.taskId}: ${t.description} (${t.status})`;
            }
          }
          return info;
        }

        // Show all agents
        const agents = getAgentRegistry();
        const lines = agents.map((a) => {
          const status = getAgentSessionStatus(a.slug);
          const runningTasks = status.tasks.filter((t) => t.status === "running");
          const sessionBadge = runningTasks.length > 0 ? "●" : "○";
          const taskInfo = runningTasks.length > 0 ? ` (${runningTasks.length} task(s) running)` : "";
          return `${sessionBadge} @${a.slug} — ${a.description} [${a.model}]${taskInfo}`;
        });
        return `Agents (${agents.length}):\n${lines.join("\n")}`;
      },
    }),

    defineTool("get_agent_result", {
      description: "Get the result of a completed agent task.",
      parameters: z.object({
        task_id: z.string().describe("The task ID (from delegate_to_agent)"),
      }),
      handler: async (args) => {
        const task = getTask(args.task_id);
        if (!task) {
          // Check DB for completed tasks that may have been cleared from memory
          const db = getDb();
          const row = db.prepare(`SELECT * FROM agent_tasks WHERE task_id = ?`).get(args.task_id) as any;
          if (!row) return `Task '${args.task_id}' not found.`;
          return `Task ${row.task_id} (@${row.agent_slug})\nStatus: ${row.status}\nDescription: ${row.description}\n\nResult:\n${row.result || "(no result)"}`;
        }
        if (task.status === "running") {
          const elapsed = Math.round((Date.now() - task.startedAt) / 1000);
          return `Task ${task.taskId} is still running (${elapsed}s elapsed).`;
        }
        return `Task ${task.taskId} (@${task.agentSlug}) — ${task.status}\n\nResult:\n${task.result || "(no result)"}`;
      },
    }),

    defineTool("show_agent_roster", {
      description: "List all registered agents with their name, model, status, and current tasks.",
      parameters: z.object({}),
      handler: async () => {
        const agents = getAgentRegistry();
        if (agents.length === 0) return "No agents registered.";

        const lines = agents.map((a) => {
          const status = getAgentSessionStatus(a.slug);
          const runningTasks = status.tasks.filter((t) => t.status === "running");
          const badge = runningTasks.length > 0 ? "● working" : "○ idle";
          const taskInfo = runningTasks.length > 0
            ? `\n    Tasks: ${runningTasks.map((t) => `${t.taskId}: ${t.description}`).join(", ")}`
            : "";
          return `• @${a.slug} (${a.name}) — ${a.model} — ${badge}${taskInfo}\n  ${a.description}`;
        });
        return `Registered agents (${agents.length}):\n${lines.join("\n")}`;
      },
    }),

    defineTool("hire_agent", {
      description:
        "Create a new custom agent by writing an .agent.md file to ~/.max/agents/. " +
        "The agent will be available immediately after creation.",
      parameters: z.object({
        slug: z.string().regex(/^[a-z0-9]+(-[a-z0-9]+)*$/).describe("Kebab-case identifier, e.g. 'data-analyst'"),
        name: z.string().describe("Human-readable name"),
        description: z.string().describe("One-line description of the agent's specialty"),
        model: z.string().describe("Model to use (e.g. 'claude-sonnet-4.6', 'gpt-5.4', or 'auto')"),
        system_prompt: z.string().describe("The agent's system prompt (markdown)"),
        skills: z.array(z.string()).optional().describe("Skills to attach to this agent"),
        tools: z.array(z.string()).optional().describe("Tool allowlist (omit for all execution tools)"),
      }),
      handler: async (args) => {
        const err = createAgentFile(
          args.slug, args.name, args.description, args.model,
          args.system_prompt, args.skills, args.tools
        );
        if (err) return err;
        // Reload registry
        loadAgents();
        return `Agent @${args.slug} created. It's ready for delegation.`;
      },
    }),

    defineTool("fire_agent", {
      description: "Remove a custom agent's .agent.md file and destroy its session. Cannot remove built-in agents.",
      parameters: z.object({
        slug: z.string().describe("The agent slug to remove"),
      }),
      handler: async (args) => {
        const err = removeAgentFile(args.slug);
        if (err) return err;
        loadAgents();
        return `Agent @${args.slug} removed.`;
      },
    }),

    defineTool("list_machine_sessions", {
      description:
        "List ALL Copilot CLI sessions on this machine — including sessions started from VS Code, " +
        "the terminal, or other tools. Shows session ID, summary, working directory. " +
        "Use this when the user asks about existing sessions running on the machine. " +
        "By default shows the 20 most recently active sessions.",
      parameters: z.object({
        cwd_filter: z.string().optional().describe("Optional: only show sessions whose working directory contains this string"),
        limit: z.number().int().min(1).max(100).optional().describe("Max sessions to return (default 20)"),
      }),
      handler: async (args) => {
        const sessionStateDir = join(homedir(), ".copilot", "session-state");
        const limit = args.limit || 20;

        let entries: { id: string; cwd: string; summary: string; updatedAt: Date }[] = [];

        try {
          const dirs = readdirSync(sessionStateDir);
          for (const dir of dirs) {
            const yamlPath = join(sessionStateDir, dir, "workspace.yaml");
            try {
              const content = readFileSync(yamlPath, "utf-8");
              const parsed = parseSimpleYaml(content);
              if (args.cwd_filter && !parsed.cwd?.includes(args.cwd_filter)) continue;
              entries.push({
                id: parsed.id || dir,
                cwd: parsed.cwd || "unknown",
                summary: parsed.summary || "",
                updatedAt: parsed.updated_at ? new Date(parsed.updated_at) : new Date(0),
              });
            } catch {
              // Skip dirs without valid workspace.yaml
            }
          }
        } catch (err: unknown) {
          if (err instanceof Error && "code" in err && (err as NodeJS.ErrnoException).code === "ENOENT") {
            return "No Copilot sessions found on this machine (session state directory does not exist yet).";
          }
          return "Could not read session state directory.";
        }

        // Sort by most recently updated
        entries.sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime());
        entries = entries.slice(0, limit);

        if (entries.length === 0) {
          return "No Copilot sessions found on this machine.";
        }

        const lines = entries.map((s) => {
          const age = formatAge(s.updatedAt);
          const summary = s.summary ? ` — ${s.summary}` : "";
          return `• ID: ${s.id}\n  ${s.cwd} (${age})${summary}`;
        });

        return `Found ${entries.length} session(s) (most recent first):\n${lines.join("\n")}`;
      },
    }),

    defineTool("attach_machine_session", {
      description:
        "Attach to an existing Copilot CLI session on this machine (e.g. one started from VS Code or terminal). " +
        "Resumes the session so you can observe or interact with it.",
      parameters: z.object({
        session_id: z.string().describe("The session ID to attach to (from list_machine_sessions)"),
        name: z.string().describe("A short name to reference this session by, e.g. 'vscode-main'"),
      }),
      handler: async (args) => {
        try {
          const session = await deps.client.resumeSession(args.session_id, {
            model: config.copilotModel,
            onPermissionRequest: approveAll,
          });

          const db = getDb();
          db.prepare(
            `INSERT OR REPLACE INTO agent_sessions (slug, copilot_session_id, model, status)
             VALUES (?, ?, ?, 'idle')`
          ).run(args.name, args.session_id, config.copilotModel);

          return `Attached to session ${args.session_id.slice(0, 8)}… as '${args.name}'.`;
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          return `Failed to attach to session: ${msg}`;
        }
      },
    }),

    defineTool("list_skills", {
      description:
        "List all available skills that Max knows. Skills are instruction documents that teach Max " +
        "how to use external tools and services (e.g. Gmail, browser automation, YouTube transcripts). " +
        "Shows skill name, description, and whether it's a local or global skill.",
      parameters: z.object({}),
      handler: async () => {
        const skills = listSkills();
        if (skills.length === 0) {
          return "No skills installed yet. Use learn_skill to teach me something new.";
        }
        const lines = skills.map(
          (s) => `• ${s.name} (${s.source}) — ${s.description}`
        );
        return `Available skills (${skills.length}):\n${lines.join("\n")}`;
      },
    }),

    defineTool("learn_skill", {
      description:
        "Teach Max a new skill by creating a SKILL.md instruction file. Use this when the user asks Max " +
        "to do something it doesn't know how to do yet (e.g. 'check my email', 'search the web'). " +
        "First, use a worker session to research what CLI tools are available on the system (run 'which', " +
        "'--help', etc.), then create the skill with the instructions you've learned. " +
        "The skill becomes available on the next message (no restart needed).",
      parameters: z.object({
        slug: z.string().regex(/^[a-z0-9]+(-[a-z0-9]+)*$/).describe("Short kebab-case identifier for the skill, e.g. 'gmail', 'web-search'"),
        name: z.string().refine(s => !s.includes('\n'), "must be single-line").describe("Human-readable name for the skill, e.g. 'Gmail', 'Web Search'"),
        description: z.string().refine(s => !s.includes('\n'), "must be single-line").describe("One-line description of when to use this skill"),
        instructions: z.string().describe(
          "Markdown instructions for how to use the skill. Include: what CLI tool to use, " +
          "common commands with examples, authentication steps if needed, tips and gotchas. " +
          "This becomes the SKILL.md content body."
        ),
      }),
      handler: async (args) => {
        return createSkill(args.slug, args.name, args.description, args.instructions);
      },
    }),

    defineTool("uninstall_skill", {
      description:
        "Remove a skill from Max's local skills directory (~/.max/skills/). " +
        "The skill will no longer be available on the next message. " +
        "Only works for local skills — bundled and global skills cannot be removed this way.",
      parameters: z.object({
        slug: z.string().regex(/^[a-z0-9]+(-[a-z0-9]+)*$/).describe("The kebab-case slug of the skill to remove, e.g. 'gmail', 'web-search'"),
      }),
      handler: async (args) => {
        const result = removeSkill(args.slug);
        return result.message;
      },
    }),

    defineTool("list_models", {
      description:
        "List all available Copilot models. Shows model id, name, and billing tier. " +
        "Marks the currently active model. Use when the user asks what models are available " +
        "or wants to know which model is in use.",
      parameters: z.object({}),
      handler: async () => {
        try {
          const models = await deps.client.listModels();
          if (models.length === 0) {
            return "No models available.";
          }
          const current = config.copilotModel;
          const lines = models.map((m) => {
            const active = m.id === current ? " ← active" : "";
            const billing = m.billing ? ` (${m.billing.multiplier}x)` : "";
            return `• ${m.id}${billing}${active}`;
          });
          return `Available models (${models.length}):\n${lines.join("\n")}\n\nCurrent: ${current}`;
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          return `Failed to list models: ${msg}`;
        }
      },
    }),

    defineTool("switch_model", {
      description:
        "Switch the Copilot model Max uses for conversations. Takes effect on the next message. " +
        "The change is persisted across restarts. Use when the user asks to change or switch models.",
      parameters: z.object({
        model_id: z.string().describe("The model id to switch to (from list_models)"),
      }),
      handler: async (args) => {
        try {
          const models = await deps.client.listModels();
          const match = models.find((m) => m.id === args.model_id);
          if (!match) {
            const suggestions = models
              .filter((m) => m.id.includes(args.model_id) || m.id.toLowerCase().includes(args.model_id.toLowerCase()))
              .map((m) => m.id);
            const hint = suggestions.length > 0
              ? ` Did you mean: ${suggestions.join(", ")}?`
              : " Use list_models to see available options.";
            return `Model '${args.model_id}' not found.${hint}`;
          }

          const previous = config.copilotModel;
          config.copilotModel = args.model_id;
          persistModel(args.model_id);

          // Apply model change to the live session immediately
          try {
            await switchSessionModel(args.model_id);
          } catch (err) {
            console.log(`[max] setModel() failed during switch_model (will apply on next session): ${err instanceof Error ? err.message : err}`);
          }

          // Disable router when manually switching — user has explicit preference
          if (getRouterConfig().enabled) {
            updateRouterConfig({ enabled: false });
            return `Switched model from '${previous}' to '${args.model_id}'. Auto-routing disabled (use /auto or toggle_auto to re-enable).`;
          }

          return `Switched model from '${previous}' to '${args.model_id}'.`;
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          return `Failed to switch model: ${msg}`;
        }
      },
    }),

    defineTool("toggle_auto", {
      description:
        "Enable or disable automatic model routing (auto mode). When enabled, Max automatically picks " +
        "the best model (fast/standard/premium) for each message to save cost and optimize speed. " +
        "Use when the user asks to turn auto-routing on or off.",
      parameters: z.object({
        enabled: z.boolean().describe("true to enable auto-routing, false to disable"),
      }),
      handler: async (args) => {
        const updated = updateRouterConfig({ enabled: args.enabled });
        if (args.enabled) {
          const tiers = updated.tierModels;
          return `Auto-routing enabled. Tier models:\n• fast: ${tiers.fast}\n• standard: ${tiers.standard}\n• premium: ${tiers.premium}\n\nMax will automatically pick the best model for each message.`;
        }
        return `Auto-routing disabled. Using fixed model: ${config.copilotModel}`;
      },
    }),

    // ----- Wiki-backed memory facades (preserve existing remember/recall/forget UX) -----

    defineTool("remember", {
      description:
        "Save a fact, preference, or detail to the wiki. Routes to entity-specific pages automatically. " +
        "Use for discrete facts ('Burke prefers dark mode', 'Project uses Vercel'). " +
        "For richer knowledge pages, use wiki_update instead.",
      parameters: z.object({
        category: z.enum(["preference", "fact", "project", "person", "routine", "decision"])
          .describe("Category: preference (likes/dislikes/settings), fact (general knowledge), project (codebase/repo info), person (people info), routine (schedules/habits), decision (choices made)"),
        content: z.string().describe("The thing to remember — a concise, self-contained statement"),
        entity: z.string().optional().describe("The specific entity this is about (e.g. 'burke', 'max', 'vercel'). Routes to a dedicated entity page."),
        related: z.array(z.string()).optional().describe("Wiki page paths this connects to, for cross-referencing"),
      }),
      handler: async (args) => {
        return withWikiWrite(async () => {
          ensureWikiStructure();
          const now = new Date().toISOString().slice(0, 10);

          // Entity routing: code-authoritative slugification and page lookup
          let pagePath: string;
          let title: string;
          if (args.entity) {
            const slug = args.entity.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
            const categoryDir = getCategoryDir(args.category);
            pagePath = `pages/${categoryDir}/${slug}.md`;

            // Check for existing page with fuzzy match before creating new
            const existingPages = searchIndex(args.entity, 5);
            const existingMatch = existingPages.find((p) => {
              const pSlug = p.path.split("/").pop()?.replace(".md", "") || "";
              return pSlug === slug || p.title.toLowerCase() === args.entity!.toLowerCase();
            });
            if (existingMatch) {
              pagePath = existingMatch.path;
              title = existingMatch.title;
            } else {
              title = args.entity.split(/[-_\s]+/).map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(" ");
            }
          } else {
            const categoryMap: Record<string, string> = {
              preference: "pages/preferences.md",
              fact: "pages/facts.md",
              project: "pages/projects.md",
              person: "pages/people.md",
              routine: "pages/routines.md",
              decision: "pages/decisions.md",
            };
            pagePath = categoryMap[args.category] || `pages/${args.category}.md`;
            title = args.category.charAt(0).toUpperCase() + args.category.slice(1);
          }

          // Defense-in-depth: pagePath is constructed from controlled parts but
          // assertPagePath will catch any drift (e.g. an entity slug producing "..").
          assertPagePath(pagePath);

          const existing = readPage(pagePath);
          if (existing) {
            const updated = existing.replace(
              /^(---[\s\S]*?updated:\s*)[\d-]+/m,
              `$1${now}`
            );
            writePage(pagePath, updated.trimEnd() + `\n- ${args.content} _(${now})_\n`);
          } else {
            const tags: string[] = [args.category];
            if (args.entity) tags.push(args.entity.toLowerCase());
            const safeTags = tags.map(yamlListItem).join(", ");
            const safeRelated = (args.related || []).map(yamlListItem).join(", ");
            const page = [
              "---",
              `title: ${yamlEscape(title)}`,
              `tags: [${safeTags}]`,
              `created: ${now}`,
              `updated: ${now}`,
              `related: [${safeRelated}]`,
              "---",
              "",
              `# ${title}`,
              "",
              `- ${args.content} _(${now})_`,
              "",
            ].join("\n");
            writePage(pagePath, page);
          }

          // Rebuild the index entry from the page on disk so summary/tags/updated
          // stay in sync rather than being clobbered by the latest bullet.
          const rebuilt = buildIndexEntryForPage(pagePath, {
            title,
            section: "Knowledge",
            tags: [args.category, ...(args.entity ? [args.entity.toLowerCase()] : [])],
            updated: now,
            // Keep existing summary if present; otherwise use the new content.
            summary: indexSafe(args.content).slice(0, 120),
          });
          if (rebuilt) addToIndex(rebuilt);

          appendLog("update", `remember (${args.category}${args.entity ? `, ${args.entity}` : ""}): ${indexSafe(args.content).slice(0, 80)}`);

          const relatedHint = args.related?.length
            ? ` Related pages that may need updating: ${args.related.join(", ")}`
            : "";
          return `Remembered in ${pagePath}: "${args.content}"${relatedHint}`;
        });
      },
    }),

    defineTool("recall", {
      description:
        "Search the wiki for stored knowledge. Returns matching page summaries from the index. " +
        "Use wiki_read to drill into specific pages for deeper context. " +
        "Use when you need to look up something the user told you, or when asked 'do you remember...?'",
      parameters: z.object({
        keyword: z.string().optional().describe("Search term to match against wiki pages"),
        category: z.enum(["preference", "fact", "project", "person", "routine", "decision"]).optional()
          .describe("Optional: filter by category"),
      }),
      handler: async (args) => {
        ensureWikiStructure();

        const query = [args.keyword, args.category].filter(Boolean).join(" ");
        const matches = searchIndex(query || "", 10);

        if (matches.length === 0) {
          return "No matching memories found in the wiki. The wiki is the single source of truth — if it's not here, I don't know it yet.";
        }

        const sections: string[] = [];
        for (const match of matches) {
          const content = readPage(match.path);
          if (!content) continue;
          // Extract updated date from frontmatter
          const updatedMatch = content.match(/^updated:\s*(.+)$/m);
          const updated = updatedMatch ? ` (updated: ${updatedMatch[1].trim()})` : "";
          const body = content.replace(/^---[\s\S]*?---\s*/, "").trim();
          const trimmed = body.length > 800 ? body.slice(0, 800) + "…" : body;
          sections.push(`**${match.title}** (${match.path})${updated}:\n${trimmed}`);
        }

        return sections.length > 0
          ? `Found ${matches.length} wiki page(s):\n\n${sections.join("\n\n")}`
          : "No matching content found.";
      },
    }),

    defineTool("forget", {
      description:
        "Remove content from the wiki. Three modes: (1) page_path + content removes matching bullet lines, " +
        "(2) page_path + revision replaces a section with corrected content, " +
        "(3) page_path alone deletes the entire page.",
      parameters: z.object({
        page_path: z.string().describe("Wiki page path to modify or delete"),
        content: z.string().optional().describe("Specific text to match and remove (line-removal mode)"),
        revision: z.string().optional().describe("Replacement content for a section (section-rewrite mode)"),
        section_heading: z.string().optional().describe("The heading of the section to replace (used with revision)"),
      }),
      handler: async (args) => {
        return withWikiWrite(async () => {
          // Defense: only allow modifying real pages, never index.md / log.md / sources/.
          assertPagePath(args.page_path);

          // Delete entire page
          if (!args.content && !args.revision) {
            const page = readPage(args.page_path);
            if (!page) return `Page ${args.page_path} not found.`;
            deletePage(args.page_path);
            removeFromIndex(args.page_path);
            appendLog("delete", `forget: deleted page ${args.page_path}`);
            return `Deleted page ${args.page_path} and removed from index.`;
          }

          // Line-removal mode: remove bullet lines that match content.
          // Precision rules: prefer a single exact match (whole bullet body equals
          // the search text). If no exact match, fall back to substring match —
          // but if the substring would match >1 bullets, refuse and report so the
          // caller can disambiguate. This prevents "forget CST" from nuking every
          // bullet that happens to mention CST.
          if (args.content) {
            const page = readPage(args.page_path);
            if (!page) return `Page ${args.page_path} not found.`;
            const search = args.content.trim();
            const lines = page.split("\n");

            const isBullet = (l: string) => /^\s*[-*]\s+/.test(l);
            const bulletText = (l: string) =>
              l.replace(/^\s*[-*]\s+/, "").replace(/\s*_\(\d{4}-\d{2}-\d{2}\)_\s*$/, "").trim();

            // Pass 1: exact-bullet match (case-insensitive).
            const exactMatches: number[] = [];
            for (let i = 0; i < lines.length; i++) {
              if (isBullet(lines[i]) && bulletText(lines[i]).toLowerCase() === search.toLowerCase()) {
                exactMatches.push(i);
              }
            }

            let toRemove: Set<number>;
            if (exactMatches.length > 0) {
              toRemove = new Set(exactMatches);
            } else {
              // Pass 2: substring match — but require precision.
              const subMatches: number[] = [];
              for (let i = 0; i < lines.length; i++) {
                if (isBullet(lines[i]) && lines[i].toLowerCase().includes(search.toLowerCase())) {
                  subMatches.push(i);
                }
              }
              if (subMatches.length === 0) {
                return `No matching bullet points found in ${args.page_path}.`;
              }
              if (subMatches.length > 1) {
                const preview = subMatches.slice(0, 5)
                  .map((i) => `  • ${lines[i].trim()}`).join("\n");
                return `Refused: substring "${search}" matches ${subMatches.length} bullets in ${args.page_path}. Be more specific (paste the full bullet text), or call forget repeatedly with the exact bullet to remove. Matches:\n${preview}`;
              }
              toRemove = new Set(subMatches);
            }

            const updatedLines = lines.filter((_, i) => !toRemove.has(i));
            // Bump frontmatter `updated:` so the index reflects the change.
            const today = new Date().toISOString().slice(0, 10);
            let updated = updatedLines.join("\n").replace(
              /^(---[\s\S]*?updated:\s*)[\d-]+/m,
              `$1${today}`
            );
            writePage(args.page_path, updated);

            // Refresh the corresponding index entry from the page so the index
            // doesn't keep advertising forgotten content.
            const rebuilt = buildIndexEntryForPage(args.page_path, { updated: today });
            if (rebuilt) addToIndex(rebuilt);

            appendLog("update", `forget: removed ${toRemove.size} line(s) matching "${indexSafe(search).slice(0, 60)}" from ${args.page_path}`);
            return `Removed ${toRemove.size} line(s) from ${args.page_path}.`;
          }

          // Section-rewrite mode: replace a section with revised content
          if (args.revision) {
            const page = readPage(args.page_path);
            if (!page) return `Page ${args.page_path} not found.`;

            if (args.section_heading) {
              const headingPattern = new RegExp(
                `(^#{1,6}\\s*${args.section_heading.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*$)`,
                "m"
              );
              const headingMatch = page.match(headingPattern);
              if (!headingMatch || headingMatch.index === undefined) {
                return `Section "${args.section_heading}" not found in ${args.page_path}.`;
              }
              const sectionStart = headingMatch.index;
              const level = (headingMatch[1].match(/^#+/) || ["#"])[0].length;
              const nextHeading = page.slice(sectionStart + headingMatch[0].length)
                .search(new RegExp(`^#{1,${level}}\\s`, "m"));
              const sectionEnd = nextHeading === -1
                ? page.length
                : sectionStart + headingMatch[0].length + nextHeading;
              const updated = page.slice(0, sectionStart) + args.revision + "\n" + page.slice(sectionEnd);
              writePage(args.page_path, updated);
            } else {
              // Replace entire body (keep frontmatter)
              const fmMatch = page.match(/^---[\s\S]*?---\s*/);
              const frontmatter = fmMatch ? fmMatch[0] : "";
              writePage(args.page_path, frontmatter + args.revision + "\n");
            }

            const today = new Date().toISOString().slice(0, 10);
            const rebuilt = buildIndexEntryForPage(args.page_path, { updated: today });
            if (rebuilt) addToIndex(rebuilt);

            appendLog("update", `forget: revised section in ${args.page_path}`);
            return `Revised content in ${args.page_path}.`;
          }

          return "Nothing to do — provide content (line-removal) or revision (section-rewrite).";
        });
      },
    }),

    // ----- New wiki tools -----

    defineTool("wiki_search", {
      description:
        "Search Max's wiki knowledge base. Returns matching page titles, paths, and summaries " +
        "from the wiki index. Use this to find relevant knowledge before answering questions.",
      parameters: z.object({
        query: z.string().describe("What to search for in the wiki"),
      }),
      handler: async (args) => {
        ensureWikiStructure();
        const matches = searchIndex(args.query, 10);
        if (matches.length === 0) return "No matching wiki pages found.";
        const lines = matches.map(
          (m) => `• [${m.title}](${m.path}) — ${m.summary}`
        );
        return `Found ${matches.length} page(s):\n${lines.join("\n")}`;
      },
    }),

    defineTool("wiki_read", {
      description:
        "Read a specific wiki page by path. Use after wiki_search to read full page content. " +
        "Paths are relative to the wiki root (e.g. 'pages/preferences.md', 'index.md').",
      parameters: z.object({
        path: z.string().describe("Path to the wiki page (e.g. 'pages/people/burke.md', 'index.md')"),
      }),
      handler: async (args) => {
        ensureWikiStructure();
        const content = readPage(args.path);
        if (!content) return `Page not found: ${args.path}`;
        return content;
      },
    }),

    defineTool("wiki_update", {
      description:
        "Create or update a wiki page. You provide the full page content (markdown with optional " +
        "YAML frontmatter). The page will be written to disk and the index updated. Use this for " +
        "rich knowledge pages, entity pages, synthesis documents — anything more structured than " +
        "a quick 'remember' call. After creating/updating a page, the index is automatically updated.",
      parameters: z.object({
        path: z.string().describe("Page path relative to wiki root (e.g. 'pages/projects/max.md')"),
        title: z.string().describe("Page title for the index"),
        summary: z.string().describe("One-line summary for the index"),
        section: z.string().optional().describe("Index section (default: 'Knowledge')"),
        content: z.string().describe("Full page content (markdown)"),
      }),
      handler: async (args) => {
        return withWikiWrite(async () => {
          ensureWikiStructure();
          assertPagePath(args.path);
          writePage(args.path, args.content);
          // Rebuild from disk so the index summary/tags/updated reflect the actual page,
          // but prefer caller-supplied title/summary/section as overrides.
          const today = new Date().toISOString().slice(0, 10);
          const rebuilt = buildIndexEntryForPage(args.path, {
            title: args.title,
            summary: indexSafe(args.summary).slice(0, 160),
            section: args.section || "Knowledge",
            updated: today,
          });
          if (rebuilt) {
            // Overrides win even if the page frontmatter says otherwise.
            rebuilt.title = args.title;
            rebuilt.summary = indexSafe(args.summary).slice(0, 160);
            rebuilt.section = args.section || "Knowledge";
            addToIndex(rebuilt);
          } else {
            addToIndex({
              path: args.path,
              title: args.title,
              summary: indexSafe(args.summary).slice(0, 160),
              section: args.section || "Knowledge",
              updated: today,
            });
          }
          appendLog("update", `wiki_update: ${indexSafe(args.title)} (${args.path})`);
          return `Wiki page updated: ${args.title} (${args.path})`;
        });
      },
    }),

    defineTool("wiki_ingest", {
      description:
        "Ingest a source into the wiki. Saves the raw content as an immutable source document, " +
        "then returns it so you can create wiki pages from it. Supports URLs (fetches the page) " +
        "or raw text passed directly. For local files, read the file yourself and pass content as text.",
      parameters: z.object({
        type: z.enum(["url", "text"]).describe("Source type: 'url' to fetch a web page, 'text' for raw content"),
        source: z.string().describe("URL or raw text content"),
        name: z.string().optional().describe("Name for the source (auto-generated if omitted)"),
      }),
      handler: async (args) => {
        ensureWikiStructure();
        let content: string;
        let sourceName: string;

        if (args.type === "url") {
          // Validate URL scheme
          let parsedUrl: URL;
          try {
            parsedUrl = new URL(args.source);
          } catch {
            return "Invalid URL format.";
          }
          if (!["http:", "https:"].includes(parsedUrl.protocol)) {
            return "Only http and https URLs are supported.";
          }
          // Block private/internal addresses
          const host = parsedUrl.hostname.toLowerCase();
          if (host === "localhost" || host === "127.0.0.1" || host === "::1" ||
              host.startsWith("10.") || host.startsWith("192.168.") ||
              host.startsWith("169.254.") || host === "metadata.google.internal") {
            return "Cannot fetch internal/private URLs.";
          }
          try {
            const res = await fetch(args.source);
            if (!res.ok) {
              return `Fetch failed: ${res.status} ${res.statusText}`;
            }
            content = await res.text();
            // Strip HTML tags for a rough markdown conversion
            content = content.replace(/<script[\s\S]*?<\/script>/gi, "")
              .replace(/<style[\s\S]*?<\/style>/gi, "")
              .replace(/<[^>]+>/g, " ")
              .replace(/\s{2,}/g, " ")
              .trim();
          } catch (err) {
            return `Failed to fetch URL: ${err instanceof Error ? err.message : err}`;
          }
          sourceName = args.name || parsedUrl.hostname + "-" + Date.now();
        } else {
          content = args.source;
          sourceName = args.name || "text-" + Date.now();
        }

        const fileName = `${new Date().toISOString().slice(0, 10)}-${sourceName}.md`;
        await withWikiWrite(async () => {
          writeRawSource(fileName, content);
          appendLog("ingest", `Ingested ${args.type}: ${indexSafe(sourceName)} (${content.length} chars)`);
        });

        // Return the content so the LLM can create wiki pages from it
        const preview = content.length > 3000 ? content.slice(0, 3000) + "\n\n…(truncated)" : content;
        return `Source saved as sources/${fileName} (${content.length} chars).\n\n` +
          "Now create wiki pages from this content using wiki_update. " +
          "Update existing pages and the index as needed.\n\n" +
          `--- Source content ---\n${preview}`;
      },
    }),

    defineTool("wiki_lint", {
      description:
        "Health-check the wiki. Looks for: orphan pages (not in index), index entries pointing " +
        "to missing pages, and pages with no cross-references. Returns a report.",
      parameters: z.object({}),
      handler: async () => {
        ensureWikiStructure();
        const indexEntries = parseIndex();
        const pages = listPages();
        const sources = listSources();

        const indexPaths = new Set(indexEntries.map((e) => e.path));
        const orphans = pages.filter((p) => !indexPaths.has(p));
        const missing = indexEntries.filter((e) => !readPage(e.path));

        const report: string[] = [`Wiki health report (${pages.length} pages, ${sources.length} sources):`];

        if (orphans.length > 0) {
          report.push(`\n**Orphan pages** (not in index):\n${orphans.map((p) => `- ${p}`).join("\n")}`);
        }
        if (missing.length > 0) {
          report.push(`\n**Missing pages** (in index but not on disk):\n${missing.map((e) => `- ${e.path}: ${e.title}`).join("\n")}`);
        }
        if (orphans.length === 0 && missing.length === 0) {
          report.push("\n✅ No issues found. Index and pages are in sync.");
        }

        report.push(`\n**Suggestions**: Look for pages that should link to each other, topics mentioned but lacking their own page, and stale content that needs updating.`);

        appendLog("lint", `${orphans.length} orphans, ${missing.length} missing`);
        return report.join("\n");
      },
    }),

    defineTool("wiki_rebuild_index", {
      description:
        "Rebuild the wiki index.md from the pages on disk. Use when the index is " +
        "corrupted, out of sync with pages, or after manual edits to the wiki. " +
        "Safe to run anytime — it preserves section assignments where possible.",
      parameters: z.object({}),
      handler: async () => {
        return withWikiWrite(async () => {
          const { rebuildIndexFromPages } = await import("../wiki/index-manager.js");
          const entries = rebuildIndexFromPages();
          appendLog("lint", `wiki_rebuild_index: rebuilt ${entries.length} entries from pages on disk`);
          return `Rebuilt index with ${entries.length} entries.`;
        });
      },
    }),

    defineTool("restart_max", {
      description:
        "Restart the Max daemon process. Use when the user asks Max to restart himself, " +
        "or when a restart is needed to pick up configuration changes. " +
        "Spawns a new process and exits the current one.",
      parameters: z.object({
        reason: z.string().optional().describe("Optional reason for the restart"),
      }),
      handler: async (args) => {
        const reason = args.reason ? ` (${args.reason})` : "";
        // Dynamic import to avoid circular dependency
        const { restartDaemon } = await import("../daemon.js");
        // Schedule restart after returning the response
        setTimeout(() => {
          restartDaemon().catch((err) => {
            console.error("[max] Restart failed:", err);
          });
        }, 1000);
        return `Restarting Max${reason}. I'll be back in a few seconds.`;
      },
    }),
  ];
}

function formatAge(date: Date): string {
  const seconds = Math.floor((Date.now() - date.getTime()) / 1000);
  if (seconds < 60) return "just now";
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86400)}d ago`;
}

function parseSimpleYaml(content: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const line of content.split("\n")) {
    const idx = line.indexOf(": ");
    if (idx > 0) {
      const key = line.slice(0, idx).trim();
      const value = line.slice(idx + 2).trim();
      result[key] = value;
    }
  }
  return result;
}
