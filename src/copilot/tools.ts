import { z } from "zod";
import { defineTool, type CopilotClient, type CopilotSession, type Tool } from "@github/copilot-sdk";
import { getDb } from "../store/db.js";

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
          try {
            const result = await session.sendAndWait({
              prompt: `Working directory: ${args.working_dir}\n\n${args.initial_prompt}`,
            });
            worker.status = "idle";
            worker.lastOutput = result?.data?.content || "No response";
            db.prepare(
              `UPDATE worker_sessions SET status = 'idle', last_output = ?, updated_at = CURRENT_TIMESTAMP WHERE name = ?`
            ).run(worker.lastOutput, args.name);
            return `Worker '${args.name}' created in ${args.working_dir}.\n\nResponse:\n${worker.lastOutput}`;
          } catch (err) {
            worker.status = "error";
            const msg = err instanceof Error ? err.message : String(err);
            db.prepare(
              `UPDATE worker_sessions SET status = 'error', last_output = ?, updated_at = CURRENT_TIMESTAMP WHERE name = ?`
            ).run(msg, args.name);
            return `Worker '${args.name}' created but initial prompt failed: ${msg}`;
          }
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

        try {
          const result = await worker.session.sendAndWait({ prompt: args.prompt });
          worker.status = "idle";
          worker.lastOutput = result?.data?.content || "No response";
          db.prepare(
            `UPDATE worker_sessions SET status = 'idle', last_output = ?, updated_at = CURRENT_TIMESTAMP WHERE name = ?`
          ).run(worker.lastOutput, args.name);
          return worker.lastOutput;
        } catch (err) {
          worker.status = "error";
          const msg = err instanceof Error ? err.message : String(err);
          db.prepare(
            `UPDATE worker_sessions SET status = 'error', last_output = ?, updated_at = CURRENT_TIMESTAMP WHERE name = ?`
          ).run(msg, args.name);
          return `Worker '${args.name}' error: ${msg}`;
        }
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
        "the terminal, or other tools. Shows session ID, summary, working directory, repo, and branch. " +
        "Use this when the user asks about existing sessions running on the machine.",
      parameters: z.object({
        cwd: z.string().optional().describe("Optional: filter by working directory"),
        repository: z.string().optional().describe("Optional: filter by GitHub repo (owner/repo format)"),
      }),
      handler: async (args) => {
        const filter: Record<string, string> = {};
        if (args.cwd) filter.cwd = args.cwd;
        if (args.repository) filter.repository = args.repository;

        const sessions = await deps.client.listSessions(
          Object.keys(filter).length > 0 ? filter : undefined
        );

        if (sessions.length === 0) {
          return "No Copilot sessions found on this machine.";
        }

        const lines = sessions.map((s) => {
          const ctx = s.context;
          const dir = ctx?.cwd || "unknown";
          const repo = ctx?.repository ? ` (${ctx.repository})` : "";
          const branch = ctx?.branch ? ` [${ctx.branch}]` : "";
          const summary = s.summary ? ` — ${s.summary}` : "";
          const age = formatAge(s.modifiedTime);
          return `• ID: ${s.sessionId}\n  ${dir}${repo}${branch} (${age})${summary}`;
        });

        return `Found ${sessions.length} session(s) on this machine:\n${lines.join("\n")}`;
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
  ];
}

function formatAge(date: Date): string {
  const seconds = Math.floor((Date.now() - date.getTime()) / 1000);
  if (seconds < 60) return "just now";
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86400)}d ago`;
}
