# Plan: Add `/models` command

Show all available Copilot models (marking the current one) via a new `/models` command in both the TUI and Telegram.

---

## Steps

### Phase 1: API endpoint
1. Add `GET /models` endpoint to `src/api/server.ts` — dynamically import `getClient`, call `client.listModels()`, return `{ models: string[], current: string }`. Place it directly after the existing `GET /model` handler (~line 161). Follow the same dynamic-import pattern as `POST /model`.

### Phase 2: TUI
2. Add `cmdModels()` function to `src/tui/index.ts` (after `cmdModel`, ~line 762) — calls `apiGet("/models", ...)` and prints each model id, using `C.cyan` + `← current` marker to highlight the active model.
3. Add dispatch line `if (trimmed === "/models") { cmdModels(); return; }` **before** the existing `/model` check (~line 954) so `/models` is not swallowed by the `startsWith("/model")` check.
4. Update `cmdHelp()` (~line 857) to add `/models` line.

### Phase 3: Telegram
5. Add `bot.command("models", ...)` handler to `src/telegram/bot.ts` (after the `model` command, ~line 80) — same dynamic-import `getClient` pattern, formats list with `← current` marker.
6. Update the `/help` reply text to include `/models — List available models`.

---

## Relevant files
- `src/api/server.ts` — add `GET /models` after `GET /model` (~line 161)
- `src/tui/index.ts` — add `cmdModels()` (~line 762), dispatch (~line 954), help entry (~line 857)
- `src/telegram/bot.ts` — add `bot.command("models", ...)` (~line 80), update `/help` text

---

## Verification
1. Run `npm run build` — should compile with no errors
2. TUI: type `/models` → should print all model IDs with the current one marked
3. TUI: type `/help` → `/models` should appear in the output
4. Telegram: send `/models` → should reply with model list
5. Telegram: send `/help` → `/models` should appear in the command list

---

## Decisions
- `/models` is a separate command from `/model` — `/model` shows/switches current, `/models` lists all
- TUI dispatch places `/models` check before the `startsWith("/model")` check to avoid ambiguity
- Telegram follows the same dynamic-import-of-`getClient` pattern as the existing `/model` command
