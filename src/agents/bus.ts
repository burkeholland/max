// ---------------------------------------------------------------------------
// AgentBus — coordination layer for persistent specialist agents
// ---------------------------------------------------------------------------

import { approveAll, type CopilotClient, type CopilotSession } from "@github/copilot-sdk";
import { type AgentConfig, getAgent, listAgents } from "./registry.js";
import { getAgentRelevantMemories, getAgentMemorySummary, addAgentMemory, searchAgentMemories, countAgentMemories } from "./memory.js";
import { saveAgentSession, getAgentSession, updateAgentSessionStatus, deleteAgentSession } from "../store/db.js";
import { config } from "../config.js";
import { SESSIONS_DIR } from "../paths.js";
import { z } from "zod";
import { defineTool, type Tool } from "@github/copilot-sdk";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface AgentInstance {
  slug: string;
  config: AgentConfig;
  session: CopilotSession;
  status: "idle" | "running" | "error";
  lastActive: number;
  lastError?: string;
  currentTask?: string;
}

export type AgentEventType =
  | "agent:spawned"
  | "agent:response"
  | "agent:error"
  | "agent:idle"
  | "agent:destroyed";

export type AgentEventCallback = (type: AgentEventType, slug: string, data?: string) => void;

export interface ChainStep {
  agent: string;
  prompt: string;
}

export interface ChainOptions {
  onProgress?: (step: ChainStep, index: number, total: number) => void;
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

const agents = new Map<string, AgentInstance>();
const agentLocks = new Map<string, Promise<void>>();
let busClient: CopilotClient | undefined;
let idleCheckTimer: ReturnType<typeof setInterval> | undefined;
let eventCallback: AgentEventCallback | undefined;

/** Serialize operations per agent slug to prevent spawn/dispatch/destroy races. */
async function withAgentLock<T>(slug: string, fn: () => Promise<T>): Promise<T> {
  const prev = agentLocks.get(slug) ?? Promise.resolve();
  let resolve: () => void;
  const next = new Promise<void>((r) => { resolve = r; });
  agentLocks.set(slug, next);
  try {
    await prev;
    return await fn();
  } finally {
    resolve!();
    if (agentLocks.get(slug) === next) agentLocks.delete(slug);
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function setAgentEventCallback(cb: AgentEventCallback): void {
  eventCallback = cb;
}

function emit(type: AgentEventType, slug: string, data?: string): void {
  eventCallback?.(type, slug, data);
}

/** Initialize the bus with the SDK client. */
export function initAgentBus(client: CopilotClient): void {
  busClient = client;
  startIdleCheck();
}

/** Shut down all agent sessions and stop the idle timer. */
export async function shutdownAgentBus(): Promise<void> {
  if (idleCheckTimer) {
    clearInterval(idleCheckTimer);
    idleCheckTimer = undefined;
  }
  await Promise.allSettled(
    Array.from(agents.values()).map((a) => a.session.destroy().catch(() => {}))
  );
  agents.clear();
}

/** Get the in-memory map of active agent instances. */
export function getAgentInstances(): Map<string, AgentInstance> {
  return agents;
}

// ---------------------------------------------------------------------------
// Agent Tools — memory tools scoped to the agent's namespace
// ---------------------------------------------------------------------------

function createAgentTools(agentSlug: string): Tool<any>[] {
  return [
    defineTool("remember", {
      description:
        "Save something to your long-term memory. Use when the user says 'remember that...', " +
        "states a preference, or shares important information about your domain.",
      parameters: z.object({
        category: z.enum(["preference", "fact", "project", "person", "routine"])
          .describe("Category of the memory"),
        content: z.string().describe("The thing to remember"),
        source: z.enum(["user", "auto"]).optional().describe("'user' if explicitly asked, 'auto' if detected"),
      }),
      handler: async (args) => {
        const id = addAgentMemory(agentSlug, args.category, args.content, args.source || "user");
        return `Remembered (#${id}, ${args.category}): "${args.content}"`;
      },
    }),

    defineTool("recall", {
      description:
        "Search your long-term memory for stored facts, preferences, or information.",
      parameters: z.object({
        keyword: z.string().optional().describe("Search term"),
        category: z.enum(["preference", "fact", "project", "person", "routine"]).optional(),
      }),
      handler: async (args) => {
        const results = searchAgentMemories(agentSlug, args.keyword, args.category);
        if (results.length === 0) return "No matching memories found.";
        const lines = results.map(
          (m) => `• #${m.id} [${m.category}] ${m.content} (${m.source}, ${m.created_at})`
        );
        return `Found ${results.length} memory/memories:\n${lines.join("\n")}`;
      },
    }),

    defineTool("request_context", {
      description:
        "Request cross-domain context from Max when you don't have the information you need. " +
        "Max can check other specialists' memories or answer your question directly.",
      parameters: z.object({
        question: z.string().describe("What you need to know — be specific"),
      }),
      handler: async (args) => {
        // This is a signal to the orchestrator — the response will be injected by Max
        return `[Context request from ${agentSlug}]: ${args.question}\n\n(Max will provide the context you need.)`;
      },
    }),
  ];
}

// ---------------------------------------------------------------------------
// Spawn / Resume
// ---------------------------------------------------------------------------

async function ensureClient(): Promise<CopilotClient> {
  if (!busClient) throw new Error("AgentBus not initialized — call initAgentBus() first");
  return busClient;
}

/** Spawn or resume a specialist agent session. */
async function spawnAgent(agentConfig: AgentConfig): Promise<AgentInstance> {
  if (agents.size >= config.maxConcurrentAgents) {
    // Evict the least recently used idle agent
    let oldestIdle: AgentInstance | undefined;
    for (const inst of agents.values()) {
      if (inst.status === "idle" && (!oldestIdle || inst.lastActive < oldestIdle.lastActive)) {
        oldestIdle = inst;
      }
    }
    if (oldestIdle) {
      console.log(`[max] Agent limit reached, evicting idle agent '${oldestIdle.slug}'`);
      await destroyAgent(oldestIdle.slug);
    } else {
      throw new Error(`Agent limit reached (${config.maxConcurrentAgents}). No idle agents to evict.`);
    }
  }

  const client = await ensureClient();
  const model = agentConfig.model || config.copilotModel;
  const memorySummary = getAgentMemorySummary(agentConfig.slug);

  const systemMessage = buildAgentSystemMessage(agentConfig, memorySummary);
  const tools = createAgentTools(agentConfig.slug);

  const infiniteSessions = {
    enabled: true,
    backgroundCompactionThreshold: 0.80,
    bufferExhaustionThreshold: 0.95,
  };

  // Try to resume a saved session
  const saved = getAgentSession(agentConfig.slug);
  let session: CopilotSession | undefined;

  if (saved) {
    try {
      console.log(`[max] Resuming agent '${agentConfig.slug}' session ${saved.copilot_session_id.slice(0, 8)}…`);
      session = await client.resumeSession(saved.copilot_session_id, {
        model,
        configDir: SESSIONS_DIR,
        streaming: false,
        systemMessage: { content: systemMessage },
        tools,
        onPermissionRequest: approveAll,
        infiniteSessions,
      });
      console.log(`[max] Resumed agent '${agentConfig.slug}' successfully`);
    } catch (err) {
      console.log(`[max] Could not resume agent '${agentConfig.slug}': ${err instanceof Error ? err.message : err}. Creating new.`);
      deleteAgentSession(agentConfig.slug);
      session = undefined;
    }
  }

  if (!session) {
    console.log(`[max] Creating new session for agent '${agentConfig.slug}'`);
    session = await client.createSession({
      model,
      configDir: SESSIONS_DIR,
      streaming: false,
      systemMessage: { content: systemMessage },
      tools,
      onPermissionRequest: approveAll,
      infiniteSessions,
    });
    saveAgentSession(agentConfig.slug, session.sessionId, model);
    console.log(`[max] Agent '${agentConfig.slug}' session created: ${session.sessionId.slice(0, 8)}…`);
  }

  const instance: AgentInstance = {
    slug: agentConfig.slug,
    config: agentConfig,
    session,
    status: "idle",
    lastActive: Date.now(),
  };

  agents.set(agentConfig.slug, instance);
  emit("agent:spawned", agentConfig.slug);
  return instance;
}

function buildAgentSystemMessage(agentConfig: AgentConfig, memorySummary: string): string {
  const memoryBlock = memorySummary
    ? `\n## Your Long-Term Memory\n${memorySummary}\n`
    : "";

  return `You are ${agentConfig.name}, a specialist agent working as part of Max's team. ${agentConfig.systemPrompt}

## How You Work

You are a persistent specialist agent. Your conversation history is maintained across tasks. You have your own memory namespace — use the \`remember\` and \`recall\` tools to save and retrieve domain-specific information.

If you need information outside your domain, use the \`request_context\` tool to ask Max for help. He can check other specialists or answer directly.

Keep your responses focused on your domain of expertise. Be concise and actionable.
${memoryBlock}`;
}

// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------

/**
 * Dispatch a prompt to a specialist agent. Spawns the agent if needed.
 * Returns the agent's response text.
 */
export async function dispatch(
  agentSlug: string,
  prompt: string,
  timeoutMs = 300_000
): Promise<string> {
  const agentConfig = getAgent(agentSlug);
  if (!agentConfig) {
    return `No agent defined with slug '${agentSlug}'. Available: ${listAgents().map((a) => a.slug).join(", ")}`;
  }

  return withAgentLock(agentSlug, async () => {
    let instance = agents.get(agentSlug);
    if (!instance) {
      instance = await spawnAgent(agentConfig);
    }

    instance.status = "running";
    instance.lastActive = Date.now();
    instance.currentTask = prompt.slice(0, 200);
    updateAgentSessionStatus(agentSlug, "running");

    // Inject relevant memories
    let enrichedPrompt = prompt;
    try {
      const relevant = getAgentRelevantMemories(agentSlug, prompt, 5);
      if (relevant.length > 0) {
        const memBlock = relevant.join("; ");
        const trimmed = memBlock.length > 500 ? memBlock.slice(0, 500) + "…" : memBlock;
        enrichedPrompt = `[Memory context: ${trimmed}]\n\n${prompt}`;
      }
    } catch { /* non-fatal */ }

    try {
      const result = await instance.session.sendAndWait({ prompt: enrichedPrompt }, timeoutMs);
      const content = result?.data?.content || "(No response)";
      instance.status = "idle";
      instance.lastActive = Date.now();
      instance.currentTask = undefined;
      instance.lastError = undefined;
      updateAgentSessionStatus(agentSlug, "idle");
      emit("agent:response", agentSlug, content);
      return content;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      instance.status = "error";
      instance.lastError = msg;
      instance.currentTask = undefined;
      updateAgentSessionStatus(agentSlug, "error");
      emit("agent:error", agentSlug, msg);

      // If session is broken, invalidate for recreation
      if (/closed|destroy|disposed|invalid|expired|not found/i.test(msg)) {
        console.log(`[max] Agent '${agentSlug}' session appears dead, will recreate: ${msg}`);
        agents.delete(agentSlug);
        deleteAgentSession(agentSlug);
      }

      throw err;
    }
  });
}

// ---------------------------------------------------------------------------
// Chaining
// ---------------------------------------------------------------------------

/**
 * Execute a chain of agent steps sequentially.
 * Each step's output is available to the next step via {{prev}}.
 */
export async function chain(
  steps: ChainStep[],
  options?: ChainOptions,
): Promise<string> {
  let previousOutput = "";

  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];
    options?.onProgress?.(step, i, steps.length);

    // Replace {{prev}} placeholder with previous output
    const prompt = step.prompt.replace(/\{\{prev\}\}/g, previousOutput);

    try {
      previousOutput = await dispatch(step.agent, prompt);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.log(`[max] Chain step ${i + 1}/${steps.length} failed (agent: ${step.agent}): ${msg}`);

      // Try recovery: retry once
      try {
        previousOutput = await dispatch(step.agent, prompt);
      } catch (retryErr) {
        const retryMsg = retryErr instanceof Error ? retryErr.message : String(retryErr);
        // Skip this step, pass error context forward
        previousOutput = `[Error from ${step.agent}: ${retryMsg}. Previous context: ${previousOutput}]`;
      }
    }
  }

  return previousOutput;
}

// ---------------------------------------------------------------------------
// Status & Management
// ---------------------------------------------------------------------------

export interface AgentStatus {
  slug: string;
  name: string;
  emoji: string;
  status: "idle" | "running" | "error" | "not_spawned";
  lastActive?: number;
  currentTask?: string;
  lastError?: string;
  memoryCount: number;
}

export function getAgentStatus(slug: string): AgentStatus {
  const agentConfig = getAgent(slug);
  if (!agentConfig) {
    return { slug, name: slug, emoji: "❓", status: "not_spawned", memoryCount: 0 };
  }

  const instance = agents.get(slug);
  if (!instance) {
    return {
      slug,
      name: agentConfig.name,
      emoji: agentConfig.emoji,
      status: "not_spawned",
      memoryCount: countAgentMemories(slug),
    };
  }

  return {
    slug,
    name: instance.config.name,
    emoji: instance.config.emoji,
    status: instance.status,
    lastActive: instance.lastActive,
    currentTask: instance.currentTask,
    lastError: instance.lastError,
    memoryCount: countAgentMemories(slug),
  };
}

export function getAllAgentStatuses(): AgentStatus[] {
  return listAgents().map((a) => getAgentStatus(a.slug));
}

/** Destroy a specific agent session. */
export async function destroyAgent(slug: string): Promise<void> {
  return withAgentLock(slug, async () => {
    const instance = agents.get(slug);
    if (instance) {
      // Remove from map first to prevent dispatch picking up a dying session
      agents.delete(slug);
      deleteAgentSession(slug);
      try { await instance.session.destroy(); } catch { /* best-effort */ }
      emit("agent:destroyed", slug);
      console.log(`[max] Agent '${slug}' destroyed`);
    }
  });
}

// ---------------------------------------------------------------------------
// Idle Cleanup
// ---------------------------------------------------------------------------

function startIdleCheck(): void {
  if (idleCheckTimer) return;
  // Check every 5 minutes
  idleCheckTimer = setInterval(() => {
    const now = Date.now();
    const timeout = config.agentIdleTimeoutMs;
    for (const [slug, instance] of agents) {
      if (instance.status === "idle" && (now - instance.lastActive) > timeout) {
        console.log(`[max] Agent '${slug}' idle for >${Math.round(timeout / 60_000)}min, destroying`);
        destroyAgent(slug).catch((err) => {
          console.error(`[max] Failed to destroy idle agent '${slug}':`, err instanceof Error ? err.message : err);
        });
        emit("agent:idle", slug);
      }
    }
  }, 300_000);
}
