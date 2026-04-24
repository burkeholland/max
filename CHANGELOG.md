# Changelog

All notable changes to Max are documented here.

## [1.5.2] — 2026-04-24

### Bug fixes
- Fix `hire_agent` and skill create/remove broken on Windows due to hardcoded `/` path separator in traversal guards — now uses `path.sep`.

---

## [1.5.0] — 2026-04-22

### Multi-agent system
- Replace ephemeral workers with a persistent multi-agent architecture — Max now delegates to specialist agents (coder, designer, general-purpose) that run in their own Copilot sessions.
- Bundled agent definitions ship with Max and auto-sync on startup; user customizations are preserved.
- `delegate_to_agent` now includes a summary field for compact `/workers` display.
- Show agent name and model in `/workers` output.
- All agents get full tool access by default.

### Wiki memory v2
- Complete rewrite of the wiki memory system for reliability and correctness.
- Ranked index-first context injection — every message carries a relevance + recency-scored table of contents instead of force-feeding stale page bodies.
- Episodic memory — after extended conversations, a background writer summarizes the session into daily conversation pages with cross-references.
- Wiki reorganization — flat ingested dumps are automatically split into per-entity pages (`people/`, `projects/`, etc.).
- Richer wiki index with tags, dates, and improved search ranking.
- `remember`, `recall`, `forget` redesigned as wiki-only tools.
- SQLite memory legacy fully removed — automatic migration on upgrade.

### Skills
- Bundle the `frontend-design` skill with an updated designer agent prompt.

### Bug fixes
- Fix Telegram errors on long messages (chunk messages that exceed Telegram's limit).
- Fix `model_override` always being ignored for non-auto agents.
- Fix orchestrator timeout: never surface timeout errors to user.
- Fix duplicate messages caused by timeout retries.
- Prune orphaned session folders at startup (older than 7 days).

### Under the hood
- Update `@github/copilot-sdk` to 0.2.2.
- Updated docs, README, and system message for the new memory and agent systems.

---

## [1.4.0] — 2026-04-05

### Wiki-based memory
- Replace flat SQLite memory with an LLM-maintained wiki knowledge base at `~/.max/wiki/`.
- Per-entity markdown pages with YAML frontmatter, tags, and `[[wiki links]]`.
- Tools: `remember`, `recall`, `wiki_search`, `wiki_read`, `wiki_update`, `wiki_ingest`, `wiki_lint`, `forget`.
- Automatic migration from SQLite memories to wiki pages on first launch.
- Updated landing page and docs with wiki memory feature.

---

## [1.3.0] — 2026-04-02

### Telegram enhancements
- Handle Telegram reply context and incoming photos.

### Memory foundations
- Add memory system foundations (pre-wiki, SQLite-based).

---

## [1.2.2] — 2026-03-17

### Auto model routing fixes
- Disable auto model routing by default (opt-in with `/auto`).
- Fix auto-router cooldown blocking first model switch.
- Add `/auto` command to Telegram bot.
- Show current model when toggling auto mode off.
- Hide model name in Telegram when auto-routing is off.

---

## [1.2.1] — 2026-03-17

### Hotfix
- Pin `@github/copilot-sdk` to 0.1.30 to fix ESM import crash.

---

## [1.2.0] — 2026-03-17

### Smart model router
- Add automatic model routing — Max classifies messages by complexity and picks the cheapest model that can handle it (GPT-4.1 for trivial, GPT-5.1 for moderate, Claude Sonnet for complex).
- `/auto` toggle in both TUI and Telegram.
- Model indicator shown on responses when auto mode is active.

### TUI improvements
- ANSI-aware word wrapping for TUI responses.
- Hide model label in TUI when auto mode is off.

### Docs
- Add auto mode documentation and landing page feature section.

---

## [1.1.0] — 2026-03-06

### Production hardening
- Production readiness P0: OS detection, API robustness, model validation.
- Security, reliability, and code quality audit.
- Validate configured model at startup with fallback to `claude-sonnet-4.6`.
- Handle invalid Telegram token gracefully (no unhandled rejection).
- Improve Telegram auth error messages with specific guidance.
- Increase worker timeout to 10 minutes (configurable via `WORKER_TIMEOUT`).
- Fix: insert line breaks between text blocks separated by tool calls.

### Skills
- Better skills interface with table display, uninstall, and security audits.
- Replace global skill install with local-only flow via skills.sh.
- Simplify `find-skills` SKILL.md for reliable skill installation.
- Add Slack skill for secure read/write access.

### Setup
- Fetch models from Copilot SDK during `max setup` instead of hardcoded list.

### TUI
- Animated thinking indicator.
- Fix thinking line streaming UX.
- Restore blank line between YOU/MAX and add spacing between interactions.

---

## [1.0.1] — 2026-03-04

### Fixes
- Add repository URL and LICENSE to package.
- Fix `/copy` command — store last response, use ESM import.
- Add `--self-edit` flag to prevent Max from modifying his own code by default.
- Require user permission before installing skills; flag security risks.
- Fix gogcli install/auth instructions and Copilot CLI package name.
- Fix install script: redirect stdin from `/dev/tty` for setup.
- Fix TUI multiline input wrapping into YOU label.
- Add self-update capability (`max update`).

---

## [1.0.0] — 2026-03-01

### Initial release
- **Orchestrator**: persistent Copilot SDK session that receives messages and delegates coding tasks to worker sessions.
- **Telegram bot**: authenticated remote access from your phone (locked to your user ID).
- **TUI**: local terminal client with streaming, colors, markdown rendering, history, and banner.
- **Skill system**: modular skills with `learn_skill`, MCP support, and path-safe skill creation. Community skill discovery via [skills.sh](https://skills.sh).
- **Worker sessions**: async non-blocking Copilot CLI sessions in any directory with proactive notifications.
- **Memory**: conversation memory with per-message concurrent sessions.
- **Google integration**: Gmail, Calendar, Drive via gogcli setup in `max setup`.
- **Infinite sessions**: SDK-powered context compaction for long-running conversations.
- **Self-awareness**: Max knows his own architecture, channels, and identity.
- **Docs site**: landing page and documentation at max.dev.
- **Robust recovery**: auto-reconnect on SDK timeout, graceful daemon shutdown, session persistence.
