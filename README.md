# Max

AI orchestrator powered by [Copilot SDK](https://github.com/github/copilot-sdk) — control multiple Copilot CLI sessions from Telegram or a local terminal.

## Install

```bash
curl -fsSL https://raw.githubusercontent.com/burkeholland/max/main/install.sh | bash
```

Or install directly with npm:

```bash
npm install -g heymax
```

## Quick Start

### 1. Run setup

```bash
max setup
```

This creates `~/.max/` and walks you through configuration (Telegram bot token, etc.). Telegram is optional — you can use Max with just the terminal UI.

### 2. Make sure Copilot CLI is authenticated

```bash
copilot login
```

### 3. Start Max

```bash
max start
```

### 4. Connect via terminal

In a separate terminal:

```bash
max tui
```

### 5. Talk to Max

From Telegram or the TUI, just send natural language:

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
| `max help` | Show available commands |

### TUI commands

| Command | Description |
|---------|-------------|
| `/sessions` | List worker sessions |
| `/status` | Daemon health check |
| `/help` | Show help |
| `/quit` | Exit the TUI |

## How it Works

Max runs a persistent **orchestrator Copilot session** — an always-on AI brain that receives your messages and decides how to handle them. For coding tasks, it spawns **worker Copilot sessions** in specific directories. For simple questions, it answers directly.

You can talk to Max from:
- **Telegram** — remote access from your phone (authenticated by user ID)
- **TUI** — local terminal client (no auth needed)

## Architecture

```
Telegram ──→ Max Daemon ←── TUI
                │
          Orchestrator Session (Copilot SDK)
                │
      ┌─────────┼─────────┐
   Worker 1  Worker 2  Worker N
```

- **Daemon** (`max start`) — persistent service running Copilot SDK + Telegram bot + HTTP API
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
