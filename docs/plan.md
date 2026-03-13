# Agent-Max Enhancement Plan

## Problem Statement

Agent-Max is a lean Copilot SDK orchestrator (v1.1.0) with Telegram + TUI channels, SQLite-backed memory, and a basic skill scanner. Based on the OpenClaw research analysis, there are significant feature gaps. However, the current codebase also had **architectural debt** — tight coupling, no interfaces, no tests, singleton patterns — that needed to be addressed *before* piling on features.

This plan organizes work into three tiers:
- **Essentials** — ✅ COMPLETE. Architectural refactors that made the codebase modular, pluggable, and testable.
- **Quick Wins** — Low-effort, high-impact features that can be added on top of the refactored architecture.
- **Optional / Complex** — Higher-effort features with strategic value, to be tackled as needed.

---

## Current State (Post-Refactor)

| Aspect | Score | Notes |
|--------|-------|-------|
| Modularity | 9/10 | All components behind interfaces, DI container, clean separation |
| Testability | 8/10 | 63 tests, InMemoryStore for mocking, vitest infrastructure |
| Extensibility | 8/10 | New channels/providers/stores just implement an interface |
| Type Safety | 8/10 | Strict TypeScript, Zod validation, typed interfaces |
| Error Handling | 7/10 | Consistent patterns per context, but no typed errors |

---

## TIER 1: ESSENTIALS — ✅ ALL COMPLETE

- [x] **E1. Core Interfaces** — `src/types/` with ModelProvider, Channel, Store, SkillProvider, AppConfig
- [x] **E2. Store Abstraction** — SQLiteStore + InMemoryStore behind Store interface
- [x] **E3. Provider Abstraction** — CopilotProvider wrapping @github/copilot-sdk behind ModelProvider
- [x] **E4. Channel Abstraction** — ChannelRegistry + TelegramChannel + TUIChannel
- [x] **E5. DI Container** — ServiceContainer wired in daemon.ts, injected into orchestrator & tools
- [x] **E6. Split Orchestrator** — SessionManager extracted (235 lines), orchestrator focused on messaging
- [x] **E7. Test Infrastructure** — vitest + 63 tests across 5 suites (system-message, formatter, sqlite-store, memory-store, channel-registry)

---

## TIER 2: QUICK WINS (High Impact, Low Effort Features)

These build on the refactored architecture from Tier 1.

### Q1. Health Endpoint (`/health`)

Expose health status via the existing HTTP API.

**Changes:**
- Add `GET /health` to API server returning JSON: `{ status, uptime, copilot: { connected, model }, channels: [...], workers: { active, limit } }`
- Extend the 30s health check to track and report token/auth state
- Simple cooldown map for provider errors (429/auth failures)

**Effort:** ~1-2 hours. **Impact:** Monitoring, debugging, operational visibility.

### Q2. Persona System

Make the system prompt configurable and switchable.

**Changes:**
- Extract system message template to `~/.max/persona.md` (default persona)
- Support named personas in `~/.max/personas/` directory
- Add `/persona [name]` command to TUI and Telegram
- Per-channel persona overrides in config
- Refactor `system-message.ts` to load from persona files

**Effort:** ~2-3 hours. **Impact:** Customization, personality, per-use-case tuning.

### Q3. URL Fetch Tool

Add web page summarization capability.

**Changes:**
- Add `@mozilla/readability` + `linkedom` dependencies
- Add `fetch_url` tool in `tools.ts` — fetches URL, extracts readable content, returns text
- Optionally truncate to fit context window

**Effort:** ~1-2 hours. **Impact:** Dramatically expands research capability.

### Q4. FTS5 Memory Search

Upgrade keyword search to full-text search.

**Changes:**
- Add `memories_fts` FTS5 virtual table in SQLite
- Update `searchMemories()` to use `MATCH` instead of `LIKE`
- Keep `LIKE` as fallback for exact keyword matches
- Add ranking via `bm25()` function

**Effort:** ~1-2 hours. **Impact:** Much better memory recall accuracy.

### Q5. Multiple Model Providers

Support multiple providers active simultaneously, each with multiple models. Sessions target a specific model using the `provider/model_id` naming convention (e.g. `openai/gpt-4o`, `ollama/llama3`).

**Design: named provider registry with per-provider model lists**

`~/.max/config.json` declares a `providers` map where each entry configures a provider type, its authentication, and the set of models to expose from it. Individual models are then referenced as `<providerName>/<modelId>` everywhere in the system.

**Authentication modes per provider type:**

| Provider | `apiKey` | OAuth |
|---|---|---|
| `copilot` | — | ✅ device-flow (existing, handled by SDK) |
| `openai` | ✅ | — |
| `anthropic` | ✅ | — |
| `gemini` | ✅ | ✅ Google OAuth2 (`oauth` auth type) |
| `ollama` | — (local) | — |

```jsonc
{
  "providers": {
    "copilot": {
      "type": "copilot",
      "models": ["gpt-4o", "claude-sonnet-4-5"]
      // auth handled automatically by the Copilot SDK device-flow
    },
    "openai": {
      "type": "openai",
      "auth": { "type": "apiKey", "apiKey": "${OPENAI_API_KEY}" },
      "models": ["gpt-4o", "gpt-4o-mini", "o3-mini"]
    },
    "anthropic": {
      "type": "anthropic",
      "auth": { "type": "apiKey", "apiKey": "${ANTHROPIC_API_KEY}" },
      "models": ["claude-opus-4-5", "claude-sonnet-4-5", "claude-haiku-4-5"]
    },
    "gemini-key": {
      "type": "gemini",
      "auth": { "type": "apiKey", "apiKey": "${GEMINI_API_KEY}" },
      "models": ["gemini-1.5-pro", "gemini-1.5-flash"]
    },
    "gemini-oauth": {
      "type": "gemini",
      "auth": {
        "type": "oauth",
        "clientId": "${GOOGLE_CLIENT_ID}",
        "clientSecret": "${GOOGLE_CLIENT_SECRET}",
        "tokenFile": "~/.max/google-token.json"
      },
      "models": ["gemini-1.5-pro", "gemini-2.0-flash"]
    },
    "ollama": {
      "type": "ollama",
      "baseUrl": "http://localhost:11434",
      "models": ["llama3", "mistral", "codestral"]
    }
  },
  "defaultModel": "copilot/gpt-4o"
}
```

Any string value matching `${ENV_VAR_NAME}` is treated as an environment variable reference and resolved at load time — the literal `${...}` is never used as the value. This applies to `apiKey`, `clientId`, `clientSecret`, `baseUrl`, and any future sensitive fields. If the referenced env var is unset, config loading throws a descriptive error naming the missing variable.

**OAuth flow:** On first use of an OAuth-authenticated provider, if no valid token exists in `tokenFile`, the provider triggers an interactive browser-based consent flow (opening the URL in the terminal with a one-time code) and persists the resulting token+refresh token to `tokenFile`. Subsequent starts load and auto-refresh the token silently. The `ModelProvider.start()` lifecycle method owns this flow.

**Model address format:** `<providerName>/<modelId>` — e.g. `openai/gpt-4o-mini`, `ollama/codestral`. The provider name is the key in the `providers` map (user-defined). The model ID is one of the entries in that provider's `models` array. `ProviderRegistry.resolve("openai/gpt-4o")` splits on the first `/` to look up the provider and passes the model ID through to `CreateSessionOptions`.

**Changes:**

*New provider implementations (each implements `ModelProvider`):*
- `src/providers/openai-provider.ts` — uses `openai` npm package; streaming via `stream()` helper
- `src/providers/anthropic-provider.ts` — uses `@anthropic-ai/sdk`
- `src/providers/gemini-provider.ts` — uses `@google/generative-ai`
- `src/providers/ollama-provider.ts` — uses `ollama` npm package; `baseUrl` configurable for remote Ollama

*Registry & factory:*
- `src/providers/registry.ts` — `ProviderRegistry` holds all started `ModelProvider` instances keyed by provider name; exposes `resolve(modelAddress)` → `{ provider, modelId }`, `getDefault()`, `listAll()` → flat list of `provider/model_id` strings
- `src/providers/factory.ts` — reads `providers` config map, instantiates and starts each provider, returns a populated `ProviderRegistry`
- Replace single `ModelProvider` binding in `ServiceContainer` with `ProviderRegistry`

*Config & types:*
- Add `AuthConfig` discriminated union to `src/types/config.ts`: `{ type: "apiKey", apiKey: string }` | `{ type: "oauth", clientId: string, clientSecret: string, tokenFile: string }`
- Add `ProviderConfig` union type (one variant per provider type, each with `models: string[]` and an optional `auth: AuthConfig` field; `copilot` and `ollama` variants omit `auth`)
- Add `providers` map + `defaultModel` field to `AppConfig`; keep `copilotModel` as legacy fallback mapped to `copilot/<copilotModel>`
- `src/config.ts` post-processes all string values in the `providers` map: any value matching `/^\$\{([A-Z_][A-Z0-9_]*)\}$/` is replaced with `process.env[varName]`; throws a clear error if the variable is unset
- Env-var shim: if old-style `PROVIDER` / `OPENAI_API_KEY` etc. env vars are set, synthesise a single-entry `providers` map so existing setups keep working

*Session targeting:*
- `CreateSessionOptions.model` accepts the full `provider/model_id` address
- `SessionManager` calls `ProviderRegistry.resolve(model)` to get the right provider instance and bare model ID
- Add `/model <provider/model_id>` slash command in TUI and Telegram to switch per-conversation model (stored in session metadata); tab-complete from `listAll()`

*Tools:*
- Add `list_models` tool returning all available `provider/model_id` addresses + provider state (connected / disconnected)

**Effort:** ~5-7 hours. **Impact:** Multiple providers and models active simultaneously, fine-grained per-task model selection, local/private inference via Ollama, multimodal via Gemini, cost control by routing to cheaper models, zero breaking change for existing single-provider setups.

### Q6. Cron Scheduling

Add scheduled task execution.

**Changes:**
- Add `croner` dependency
- Create `src/cron/scheduler.ts` — loads `~/.max/cron.json`, schedules jobs
- Jobs inject prompts into orchestrator via `sendToOrchestrator()`
- Add `list_cron` / `add_cron` / `remove_cron` tools
- Example cron: daily standup summary, periodic health check alerts

**Effort:** ~2-3 hours. **Impact:** Proactive agent behavior without user prompting.

---

## TIER 3: OPTIONAL / COMPLEX (Strategic, Higher Effort)

### O1. Slack Channel

Add Slack as a third channel (leverages E4 channel abstraction).

**Changes:**
- `npm install @slack/bolt`
- Create `src/channels/slack-channel.ts` implementing `Channel`
- Register in channel registry when `SLACK_BOT_TOKEN` is configured
- Socket mode for simplicity (no public URL needed)

**Effort:** ~4-6 hours.

### O2. Discord Channel

**Changes:**
- `npm install discord.js`
- Create `src/channels/discord-channel.ts` implementing `Channel`

**Effort:** ~4-6 hours.

### O3. Plugin Interface

Enable third-party extensions without core changes.

**Changes:**
- Create `src/plugins/loader.ts` — scans `~/.max/plugins/*.js`
- Plugin contract: `export default { name, setup(ctx) }` where `ctx` exposes `addTool()`, `addMemoryProvider()`, `onMessage()`
- Plugin lifecycle: load → setup → teardown
- Security: plugins run in same process (trust-based, like VS Code extensions)

**Effort:** ~6-8 hours.

### O4. Vector Memory (sqlite-vec)

Semantic search using local embeddings.

**Changes:**
- Add `sqlite-vec` extension
- Embedding provider interface (Ollama local default, OpenAI optional)
- Store embeddings alongside memories
- MMR-ranked retrieval
- Temporal decay scoring
- Fallback to FTS5 when embeddings unavailable

**Effort:** ~8-12 hours.

### O5. Skill Registry / Install CLI

Enable installing skills from a registry.

**Changes:**
- `max skill install <name>` command — npm-installs or git-clones to `~/.max/skills/`
- `max skill list` — lists installed + available
- `max skill remove <name>` — uninstalls
- Optional: ClawHub-compatible registry lookup

**Effort:** ~4-6 hours.

### O6. Migrate Express → Hono + WebSocket

Replace Express with Hono for performance, add WebSocket alongside SSE.

**Changes:**
- Replace `express` with `hono` + `@hono/node-server`
- Add WebSocket transport for TUI (more reliable than SSE)
- Keep SSE as fallback
- Update TUI client to prefer WebSocket

**Effort:** ~6-8 hours.

### O7. Docker Sandbox Execution

Wrap worker sessions in Docker containers for isolation.

**Changes:**
- Create `Dockerfile.sandbox` with Node.js + common tools
- Worker creation optionally runs inside Docker container
- Mount only the specified `working_dir`
- Network isolation configurable

**Effort:** ~8-12 hours.

### O8. Per-Channel Security (Allowlists + Command Gating)

Granular security controls per channel.

**Changes:**
- Per-channel user allowlists in config
- Command gating: block specific slash commands per channel
- Mention gating: require @mention in group chats
- Audit logging for security events

**Effort:** ~4-6 hours.

---

## Dependency Graph

```
E1 (Interfaces) ──→ E2 (Store) ──→ E5 (DI Container) ──→ E7 (Tests)
                 ──→ E3 (Provider)──→ E5                ──→ Q5 (Provider Registry)
                 ──→ E4 (Channel) ──→ E5                ──→ O1 (Slack), O2 (Discord)
                                                        ──→ Q1 (Health), Q2 (Persona)
                                  ──→ E6 (Split Orchestrator)

Q3 (URL Fetch) ── standalone (just adds a tool)
Q4 (FTS5 Memory) ── depends on E2 (Store abstraction)
Q6 (Cron) ── depends on E5 (DI Container)

O3 (Plugins) ── depends on E5 (DI Container)
O4 (Vector Memory) ── depends on E2 (Store) + Q4 (FTS5)
O5 (Skill Registry) ── standalone
O6 (Hono Migration) ── depends on E4 (Channel abstraction)
O7 (Docker Sandbox) ── standalone
O8 (Security) ── depends on E4 (Channel abstraction)
```

---

## Implementation Order

**Phase 1 — Foundation (Essentials):**
1. E1 → E2 → E3 → E4 → E5 → E6 → E7

**Phase 2 — Quick Wins:**
2. Q3 (URL Fetch — standalone, can start immediately)
3. Q1 (Health) → Q2 (Persona) → Q4 (FTS5) → Q5 (Multi-Provider) → Q6 (Cron)

**Phase 3 — Optional (pick based on need):**
4. O1/O2 (Channels), O3 (Plugins), O4 (Vector), O5 (Skills CLI), O6 (Hono), O7 (Docker), O8 (Security)

---

## Notes & Considerations

- **Backward compatibility:** The refactored code must produce identical runtime behavior. No user-facing changes in Tier 1.
- **Incremental refactoring:** Each Essential can be merged independently. Don't attempt a big-bang rewrite.
- **Test-driven:** Write tests as part of each Essential, not just at the end (E7 is for the test *infrastructure* + catching up on pure functions).
- **Q3 (URL Fetch) can start in parallel** with Tier 1 since it only adds a new tool function.
- **No new dependencies in Tier 1** except `vitest` for testing. All refactoring uses existing packages.
- **OpenClaw compatibility:** The skill format is already compatible. Provider and channel abstractions should be designed to allow future OpenClaw skill/plugin interop.
