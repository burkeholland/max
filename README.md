# Max

AI orchestrator powered by [Copilot SDK](https://github.com/github/copilot-sdk) — control multiple Copilot CLI sessions from Telegram, Feishu, or a local terminal.

## Highlights

- **Always running** — persistent daemon, not a chat tab. Available from your terminal or your phone.
- **Remembers like a person** — Max keeps a personal wiki at `~/.max/wiki/` that grows with every conversation. Per-entity pages (`people/burke.md`, `projects/myapp.md`) with frontmatter, tags, and `[[cross-links]]`. A relevance-ranked index is injected into context on every message, and Max writes daily conversation summaries on his own.
- **Codes while you're away** — spins up real Copilot CLI worker sessions in any directory and reports back when they're done.
- **Learns any skill** — pulls from [skills.sh](https://skills.sh) or builds new skills on demand.
- **Your Copilot subscription** — works with any model your subscription includes (Claude, GPT, Gemini, …). Auto mode picks the right tier per message.

## Install

```bash
curl -fsSL https://raw.githubusercontent.com/burkeholland/max/main/install.sh | bash
```

Or install directly with npm:

```bash
npm install -g heymax
```

## Upgrading

If you already have Max installed:

```bash
max update
```

Or manually: `npm install -g heymax@latest`. Your `~/.max/` config carries forward automatically — SQLite memories are migrated to wiki pages, bundled agents are synced (your customizations preserved), and no data is lost.

## Quick Start

### 1. Run setup

```bash
max setup
```

This creates `~/.max/` and walks you through configuration (Telegram bot token, Feishu app credentials, etc.). All chat channels are optional — you can use Max with just the terminal UI.

### 2. Make sure Copilot CLI is authenticated

```bash
copilot login
```

### 3. Start Max

```bash
max start
```

### 4. Connect from chat or terminal

If you configured Telegram or Feishu/Lark during setup, start by messaging your bot there.

Or connect via terminal in a separate shell:

```bash
max tui
```

### 5. Talk to Max

From Telegram, Feishu/Lark, or the TUI, just send natural language:

- "Start working on the auth bug in ~/dev/myapp"
- "What sessions are running?"
- "Check on the api-tests session"
- "Kill the auth-fix session"
- "What's the capital of France?"

## Commands

| Command | Description |
|---------|-------------|
| `max start` | Start the Max daemon |
| `max tui` | Connect to the daemon via terminal |
| `max setup` | Interactive first-run configuration |
| `max update` | Check for and install updates |
| `max help` | Show available commands |

### Flags

| Flag | Description |
|------|-------------|
| `--self-edit` | Allow Max to modify his own source code (use with `max start`) |

### TUI commands

| Command | Description |
|---------|-------------|
| `/model [name]` | Show or switch the current model |
| `/memory` | Show the wiki index (everything Max has stored) |
| `/skills` | List installed skills |
| `/workers` | List active worker sessions |
| `/copy` | Copy last response to clipboard |
| `/status` | Daemon health check |
| `/restart` | Restart the daemon |
| `/cancel` | Cancel the current in-flight message |
| `/clear` | Clear the screen |
| `/help` | Show help |
| `/quit` | Exit the TUI |
| `Escape` | Cancel a running response |

## How it Works

Max runs a persistent **orchestrator Copilot session** — an always-on AI brain that receives your messages and decides how to handle them. For coding tasks, it spawns **worker Copilot sessions** in specific directories. For simple questions, it answers directly.

You can talk to Max from:
- **Telegram** — remote access from your phone (authenticated by user ID)
- **Feishu / Lark** — same as Telegram, for users in mainland China (authenticated by `open_id`)
- **TUI** — local terminal client (no auth needed)

### Memory

Max maintains a **personal wiki** at `~/.max/wiki/` instead of a flat list of memories. Knowledge is organized into per-entity markdown pages (e.g. `pages/people/burke.md`, `pages/projects/myapp.md`) with YAML frontmatter, tags, and `[[wiki links]]` between related pages.

- **`remember`** — fuzzy-matches existing pages and merges new facts in instead of duplicating
- **`recall`** / **`wiki_search`** / **`wiki_read`** — Max searches a ranked index first, then drills into specific pages
- **`forget`** — line removal, section rewrite, or whole-page deletion
- **Index-first context** — every message carries a relevance + recency-ranked table of contents of the wiki, so Max sees what he knows without force-feeding stale page bodies into every prompt
- **Episodic memory** — after long enough conversations, Max writes a daily summary to `pages/conversations/YYYY-MM-DD.md` asynchronously, never blocking your reply
- **Migration** — older SQLite-based memories are migrated and reorganized into entity pages on first launch; originals are archived to `sources/migrated-archive/`

## Architecture

```
Telegram ─┐
Feishu ───┼──→ Max Daemon ←── TUI
                   │         │
                   └─ chat   Orchestrator Session (Copilot SDK)
                                                  │
                               ┌─────────┼─────────┐
                         Worker 1  Worker 2  Worker N
```

- **Daemon** (`max start`) — persistent service running Copilot SDK + Telegram bot + Feishu/Lark bot + HTTP API
- **TUI** (`max tui`) — lightweight terminal client connecting to the daemon
- **Orchestrator** — long-running Copilot session with custom tools for session management
- **Workers** — child Copilot sessions for specific coding tasks

## Development

```bash
# Clone and install
git clone https://github.com/burkeholland/max.git
cd max
npm install

# Watch mode
npm run dev

# Build TypeScript
npm run build
```
