# Max

AI orchestrator powered by [Copilot SDK](https://github.com/github/copilot-sdk) — control multiple Copilot CLI sessions from Telegram or a local terminal.

## How it Works

Max runs a persistent **orchestrator Copilot session** — an always-on AI brain that receives your messages and decides how to handle them. For coding tasks, it spawns **worker Copilot sessions** in specific directories. For simple questions, it answers directly.

You can talk to Max from:
- **Telegram** — remote access from your phone (authenticated by user ID)
- **TUI** — local terminal client (no auth needed)

## Setup

### 1. Install dependencies

```bash
npm install
```

### 2. Create a Telegram bot

1. Open Telegram and search for **@BotFather**
2. Send `/newbot` and follow the prompts
3. Copy the bot token

### 3. Get your Telegram user ID

1. Search for **@userinfobot** on Telegram
2. Send it any message
3. Copy your user ID number

### 4. Configure environment

```bash
cp .env.example .env
```

Edit `.env` with your bot token and user ID:

```
TELEGRAM_BOT_TOKEN=your-bot-token-here
AUTHORIZED_USER_ID=123456789
```

### 5. Make sure Copilot CLI is authenticated

```bash
copilot login
```

## Usage

### Start the daemon

```bash
npm run daemon
```

This starts the Max daemon which connects to Telegram and starts the local HTTP API on port 7777.

### Connect via TUI (local terminal)

In a separate terminal:

```bash
npm run tui
```

### Talk to Max

From Telegram or the TUI, just send natural language:

- "Start working on the auth bug in ~/dev/myapp"
- "What sessions are running?"
- "Check on the api-tests session"
- "Kill the auth-fix session"
- "What's the capital of France?"

### TUI commands

| Command | Description |
|---------|-------------|
| `/sessions` | List worker sessions |
| `/status` | Daemon health check |
| `/help` | Show help |
| `/quit` | Exit the TUI |

## Architecture

```
Telegram ──→ Max Daemon ←── TUI
                │
          Orchestrator Session (Copilot SDK)
                │
      ┌─────────┼─────────┐
   Worker 1  Worker 2  Worker N
```

- **Daemon** (`npm run daemon`) — persistent service running Copilot SDK + Telegram bot + HTTP API
- **TUI** (`npm run tui`) — lightweight terminal client connecting to the daemon
- **Orchestrator** — long-running Copilot session with custom tools for session management
- **Workers** — child Copilot sessions for specific coding tasks

## Development

```bash
# Watch mode
npm run dev

# Build TypeScript
npm run build
```
