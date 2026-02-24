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
  ];
}
