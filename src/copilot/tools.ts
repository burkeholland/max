import { z } from "zod";
import { approveAll, defineTool, type CopilotClient, type CopilotSession, type Tool } from "@github/copilot-sdk";
import { getDb } from "../store/db.js";
import { readdirSync, readFileSync, statSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import { listSkills, createSkill } from "./skills.js";

export interface WorkerInfo {
  name: string;
  session: CopilotSession;
  workingDir: string;
  status: "idle" | "running" | "error";
  lastOutput?: string;
}

export interface ToolDeps {
  client: CopilotClient;
  workers: Map<string, WorkerInfo>;
  onWorkerComplete: (name: string, result: string) => void;
}

export function createTools(deps: ToolDeps): Tool<any>[] {
  return [
    defineTool("create_worker_session", {
      description:
        "Create a new Copilot CLI worker session in a specific directory. " +
        "Use for coding tasks, debugging, file operations. " +
        "Returns confirmation with session name.",
      parameters: z.object({
        name: z.string().describe("Short descriptive name for the session, e.g. 'auth-fix'"),
        working_dir: z.string().describe("Absolute path to the directory to work in"),
        initial_prompt: z.string().optional().describe("Optional initial prompt to send to the worker"),
      }),
      handler: async (args) => {
        if (deps.workers.has(args.name)) {
          return `Worker '${args.name}' already exists. Use send_to_worker to interact with it.`;
        }

        const session = await deps.client.createSession({
          model: "claude-sonnet-4.5",
          workingDirectory: args.working_dir,
          onPermissionRequest: approveAll,
        });

        const worker: WorkerInfo = {
          name: args.name,
          session,
          workingDir: args.working_dir,
          status: "idle",
        };
        deps.workers.set(args.name, worker);

        // Persist to SQLite
        const db = getDb();
        db.prepare(
          `INSERT OR REPLACE INTO worker_sessions (name, copilot_session_id, working_dir, status)
           VALUES (?, ?, ?, 'idle')`
        ).run(args.name, session.sessionId, args.working_dir);

        if (args.initial_prompt) {
          worker.status = "running";
          db.prepare(
            `UPDATE worker_sessions SET status = 'running', updated_at = CURRENT_TIMESTAMP WHERE name = ?`
          ).run(args.name);

          // Non-blocking: dispatch work and return immediately
          session.sendAndWait({
            prompt: `Working directory: ${args.working_dir}\n\n${args.initial_prompt}`,
          }).then((result) => {
            worker.status = "idle";
            worker.lastOutput = result?.data?.content || "No response";
            db.prepare(
              `UPDATE worker_sessions SET status = 'idle', last_output = ?, updated_at = CURRENT_TIMESTAMP WHERE name = ?`
            ).run(worker.lastOutput, args.name);
            deps.onWorkerComplete(args.name, worker.lastOutput);
          }).catch((err) => {
            worker.status = "error";
            const msg = err instanceof Error ? err.message : String(err);
            worker.lastOutput = msg;
            db.prepare(
              `UPDATE worker_sessions SET status = 'error', last_output = ?, updated_at = CURRENT_TIMESTAMP WHERE name = ?`
            ).run(msg, args.name);
            deps.onWorkerComplete(args.name, `Error: ${msg}`);
          });

          return `Worker '${args.name}' created in ${args.working_dir}. Task dispatched — I'll notify you when it's done.`;
        }

        return `Worker '${args.name}' created in ${args.working_dir}. Use send_to_worker to send it prompts.`;
      },
    }),

    defineTool("send_to_worker", {
      description:
        "Send a prompt to an existing worker session and wait for its response. " +
        "Use for follow-up instructions or questions about ongoing work.",
      parameters: z.object({
        name: z.string().describe("Name of the worker session"),
        prompt: z.string().describe("The prompt to send"),
      }),
      handler: async (args) => {
        const worker = deps.workers.get(args.name);
        if (!worker) {
          return `No worker named '${args.name}'. Use list_sessions to see available workers.`;
        }
        if (worker.status === "running") {
          return `Worker '${args.name}' is currently busy. Wait for it to finish or kill it.`;
        }

        worker.status = "running";
        const db = getDb();
        db.prepare(`UPDATE worker_sessions SET status = 'running', updated_at = CURRENT_TIMESTAMP WHERE name = ?`).run(
          args.name
        );

        // Non-blocking: dispatch work and return immediately
        worker.session.sendAndWait({ prompt: args.prompt }).then((result) => {
          worker.status = "idle";
          worker.lastOutput = result?.data?.content || "No response";
          db.prepare(
            `UPDATE worker_sessions SET status = 'idle', last_output = ?, updated_at = CURRENT_TIMESTAMP WHERE name = ?`
          ).run(worker.lastOutput, args.name);
          deps.onWorkerComplete(args.name, worker.lastOutput);
        }).catch((err) => {
          worker.status = "error";
          const msg = err instanceof Error ? err.message : String(err);
          worker.lastOutput = msg;
          db.prepare(
            `UPDATE worker_sessions SET status = 'error', last_output = ?, updated_at = CURRENT_TIMESTAMP WHERE name = ?`
          ).run(msg, args.name);
          deps.onWorkerComplete(args.name, `Error: ${msg}`);
        });

        return `Task dispatched to worker '${args.name}'. I'll notify you when it's done.`;
      },
    }),

    defineTool("list_sessions", {
      description: "List all active worker sessions with their name, status, and working directory.",
      parameters: z.object({}),
      handler: async () => {
        if (deps.workers.size === 0) {
          return "No active worker sessions.";
        }
        const lines = Array.from(deps.workers.values()).map(
          (w) => `• ${w.name} (${w.workingDir}) — ${w.status}`
        );
        return `Active sessions:\n${lines.join("\n")}`;
      },
    }),

    defineTool("check_session_status", {
      description: "Get detailed status of a specific worker session, including its last output.",
      parameters: z.object({
        name: z.string().describe("Name of the worker session"),
      }),
      handler: async (args) => {
        const worker = deps.workers.get(args.name);
        if (!worker) {
          return `No worker named '${args.name}'.`;
        }
        const output = worker.lastOutput
          ? `\n\nLast output:\n${worker.lastOutput.slice(0, 2000)}`
          : "";
        return `Worker '${args.name}'\nDirectory: ${worker.workingDir}\nStatus: ${worker.status}${output}`;
      },
    }),

    defineTool("kill_session", {
      description: "Terminate a worker session and free its resources.",
      parameters: z.object({
        name: z.string().describe("Name of the worker session to kill"),
      }),
      handler: async (args) => {
        const worker = deps.workers.get(args.name);
        if (!worker) {
          return `No worker named '${args.name}'.`;
        }
        try {
          await worker.session.destroy();
        } catch {
          // Session may already be gone
        }
        deps.workers.delete(args.name);

        const db = getDb();
        db.prepare(`DELETE FROM worker_sessions WHERE name = ?`).run(args.name);

        return `Worker '${args.name}' terminated.`;
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
        "Resumes the session and adds it as a managed worker so you can send prompts to it.",
      parameters: z.object({
        session_id: z.string().describe("The session ID to attach to (from list_machine_sessions)"),
        name: z.string().describe("A short name to reference this session by, e.g. 'vscode-main'"),
      }),
      handler: async (args) => {
        if (deps.workers.has(args.name)) {
          return `A worker named '${args.name}' already exists. Choose a different name.`;
        }

        try {
          const session = await deps.client.resumeSession(args.session_id, {
            model: "claude-sonnet-4.5",
            onPermissionRequest: approveAll,
          });

          const worker: WorkerInfo = {
            name: args.name,
            session,
            workingDir: "(attached)",
            status: "idle",
          };
          deps.workers.set(args.name, worker);

          const db = getDb();
          db.prepare(
            `INSERT OR REPLACE INTO worker_sessions (name, copilot_session_id, working_dir, status)
             VALUES (?, ?, '(attached)', 'idle')`
          ).run(args.name, args.session_id);

          return `Attached to session ${args.session_id.slice(0, 8)}… as worker '${args.name}'. You can now send_to_worker to interact with it.`;
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
        "The skill becomes available after restarting the daemon.",
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
