import * as readline from "readline";
import { existsSync, readFileSync, writeFileSync } from "fs";
import { ensureMaxHome, ENV_PATH, MAX_HOME } from "./paths.js";

const BOLD = "\x1b[1m";
const DIM = "\x1b[2m";
const GREEN = "\x1b[32m";
const YELLOW = "\x1b[33m";
const CYAN = "\x1b[36m";
const RESET = "\x1b[0m";

const MODELS = [
  { id: "claude-sonnet-4.5", label: "Claude Sonnet 4.5", desc: "Fast, great for most tasks" },
  { id: "claude-sonnet-4", label: "Claude Sonnet 4", desc: "Balanced speed and quality" },
  { id: "gpt-4.1", label: "GPT-4.1", desc: "OpenAI's fast model" },
  { id: "gpt-4o", label: "GPT-4o", desc: "OpenAI multimodal" },
  { id: "o3-mini", label: "o3-mini", desc: "OpenAI reasoning model" },
];

function ask(rl: readline.Interface, question: string): Promise<string> {
  return new Promise((resolve) => rl.question(question, resolve));
}

async function askRequired(rl: readline.Interface, prompt: string): Promise<string> {
  while (true) {
    const answer = (await ask(rl, prompt)).trim();
    if (answer) return answer;
    console.log(`${YELLOW}  This field is required. Please enter a value.${RESET}`);
  }
}

async function askYesNo(rl: readline.Interface, question: string, defaultYes = false): Promise<boolean> {
  const hint = defaultYes ? "(Y/n)" : "(y/N)";
  const answer = (await ask(rl, `${question} ${hint} `)).trim().toLowerCase();
  if (answer === "") return defaultYes;
  return answer === "y" || answer === "yes";
}

async function askPicker(rl: readline.Interface, label: string, options: { id: string; label: string; desc: string }[], defaultId: string): Promise<string> {
  console.log(`${BOLD}${label}${RESET}\n`);
  const defaultIdx = Math.max(0, options.findIndex((o) => o.id === defaultId));
  for (let i = 0; i < options.length; i++) {
    const marker = i === defaultIdx ? `${GREEN}▸${RESET}` : " ";
    const tag = i === defaultIdx ? ` ${DIM}(default)${RESET}` : "";
    console.log(`  ${marker} ${CYAN}${i + 1}${RESET}  ${options[i].label}${tag}`);
    console.log(`       ${DIM}${options[i].desc}${RESET}`);
  }
  console.log();
  const input = await ask(rl, `  Pick a number ${DIM}(1-${options.length}, Enter for default)${RESET}: `);
  const num = parseInt(input.trim(), 10);
  if (num >= 1 && num <= options.length) return options[num - 1].id;
  return options[defaultIdx].id;
}

async function main(): Promise<void> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

  console.log(`
${BOLD}╔══════════════════════════════════════════╗
║           🤖  Max Setup                  ║
╚══════════════════════════════════════════╝${RESET}
`);

  console.log(`${DIM}Config directory: ${MAX_HOME}${RESET}\n`);

  ensureMaxHome();

  // Load existing values if any
  const existing: Record<string, string> = {};
  if (existsSync(ENV_PATH)) {
    for (const line of readFileSync(ENV_PATH, "utf-8").split("\n")) {
      const match = line.match(/^([A-Z_]+)=(.*)$/);
      if (match) existing[match[1]] = match[2];
    }
  }

  // ── What is Max ──────────────────────────────────────────
  console.log(`${BOLD}Meet Max${RESET}`);
  console.log(`Max is your personal AI assistant — an always-on daemon that runs on`);
  console.log(`your machine. Talk to him in plain English and he'll handle the rest.`);
  console.log();
  console.log(`${CYAN}What Max can do out of the box:${RESET}`);
  console.log(`  • Have conversations and answer questions`);
  console.log(`  • Spin up Copilot CLI sessions to code, debug, and run commands`);
  console.log(`  • Manage multiple background tasks simultaneously`);
  console.log(`  • See and attach to any Copilot session on your machine`);
  console.log();
  console.log(`${CYAN}Skills — teach Max anything:${RESET}`);
  console.log(`  Max has a skill system that lets him learn new capabilities. There's`);
  console.log(`  an open source library of community skills he can install, or he can`);
  console.log(`  write his own from scratch. Just ask him:`);
  console.log();
  console.log(`  ${DIM}"Check my email"${RESET}        → Max researches how, writes a skill, does it`);
  console.log(`  ${DIM}"Turn off the lights"${RESET}   → Max finds the right CLI tool, learns it`);
  console.log(`  ${DIM}"Find me a skill for"${RESET}   → Max searches community skills and installs one`);
  console.log(`  ${DIM}"Learn how to use X"${RESET}    → Max proactively learns before you need it`);
  console.log();
  console.log(`  Skills are saved permanently — Max only needs to learn once.`);
  console.log();
  console.log(`${CYAN}How to talk to Max:${RESET}`);
  console.log(`  • ${BOLD}Terminal${RESET}  — ${CYAN}max tui${RESET} — always available, no setup needed`);
  console.log(`  • ${BOLD}Telegram${RESET} — control Max from your phone (optional, set up next)`);
  console.log();

  await ask(rl, `${DIM}Press Enter to continue...${RESET}`);
  console.log();

  // ── Telegram Setup ───────────────────────────────────────
  console.log(`${BOLD}━━━ Telegram Setup (optional) ━━━${RESET}\n`);
  console.log(`Telegram lets you talk to Max from your phone — send messages,`);
  console.log(`dispatch coding tasks, and get notified when background work finishes.`);
  console.log();

  let telegramToken = existing.TELEGRAM_BOT_TOKEN || "";
  let userId = existing.AUTHORIZED_USER_ID || "";

  const setupTelegram = await askYesNo(rl, "Would you like to set up Telegram?");

  if (setupTelegram) {
    // ── Step 1: Create bot ──
    console.log(`\n${BOLD}Step 1: Create a Telegram bot${RESET}\n`);
    console.log(`  1. Open Telegram and search for ${BOLD}@BotFather${RESET}`);
    console.log(`  2. Send ${CYAN}/newbot${RESET} and follow the prompts`);
    console.log(`  3. Copy the bot token (looks like ${DIM}123456:ABC-DEF1234ghIkl-zyx57W2v1u123ew11${RESET})`);
    console.log();

    const tokenInput = await askRequired(
      rl,
      `  Bot token${telegramToken ? ` ${DIM}(current: ${telegramToken.slice(0, 12)}...)${RESET}` : ""}: `
    );
    telegramToken = tokenInput;

    // ── Step 2: Lock it down ──
    console.log(`\n${BOLD}Step 2: Lock down your bot${RESET}\n`);
    console.log(`${YELLOW}  ⚠  IMPORTANT: Your bot is currently open to anyone on Telegram.${RESET}`);
    console.log(`  Max uses your Telegram user ID to ensure only YOU can control it.`);
    console.log(`  Without this, anyone who finds your bot could send it commands.`);
    console.log();
    console.log(`  To get your user ID:`);
    console.log(`  1. Search for ${BOLD}@userinfobot${RESET} on Telegram`);
    console.log(`  2. Send it any message`);
    console.log(`  3. It will reply with your user ID (a number like ${DIM}123456789${RESET})`);
    console.log();

    // Require user ID — cannot proceed without it
    while (true) {
      const userIdInput = await askRequired(
        rl,
        `  Your user ID${userId ? ` ${DIM}(current: ${userId})${RESET}` : ""}: `
      );
      const parsed = parseInt(userIdInput, 10);
      if (!Number.isNaN(parsed) && parsed > 0) {
        userId = userIdInput;
        break;
      }
      console.log(`${YELLOW}  That doesn't look like a valid user ID. It should be a positive number.${RESET}`);
    }

    console.log(`\n${GREEN}  ✓ Telegram locked down — only user ${userId} can control Max.${RESET}`);

    // ── Step 3: Disable group joins ──
    console.log(`\n${BOLD}Step 3: Disable group joins (recommended)${RESET}\n`);
    console.log(`  For extra security, prevent your bot from being added to groups:`);
    console.log(`  1. Go back to ${BOLD}@BotFather${RESET}`);
    console.log(`  2. Send ${CYAN}/mybots${RESET} → select your bot → ${CYAN}Bot Settings${RESET} → ${CYAN}Allow Groups?${RESET}`);
    console.log(`  3. Set to ${BOLD}Disable${RESET}`);
    console.log();

    await ask(rl, `  ${DIM}Press Enter when done (or skip)...${RESET}`);

  } else {
    console.log(`\n${DIM}  Skipping Telegram. You can always set it up later with: max setup${RESET}\n`);
  }

  // ── Google (gogcli) Setup ─────────────────────────────────
  console.log(`${BOLD}━━━ Google / Gmail Setup (optional) ━━━${RESET}\n`);
  console.log(`Max includes a Google skill that lets him read your email, manage`);
  console.log(`your calendar, access Drive, and more — using the ${BOLD}gog${RESET} CLI.`);
  console.log();

  const setupGoogle = await askYesNo(rl, "Would you like to set up Google services?");

  if (setupGoogle) {
    // ── Step 1: Install gog CLI ──
    console.log(`\n${BOLD}Step 1: Install the gog CLI${RESET}\n`);
    console.log(`  ${CYAN}brew install gogcli${RESET}     ${DIM}(macOS/Linux with Homebrew)${RESET}`);
    console.log(`  ${CYAN}go install github.com/gogcli/gog@latest${RESET}  ${DIM}(with Go)${RESET}`);
    console.log();

    await ask(rl, `  ${DIM}Press Enter when installed (or to skip)...${RESET}`);

    // ── Step 2: Authenticate ──
    console.log(`\n${BOLD}Step 2: Authenticate with your Google account${RESET}\n`);
    console.log(`  Run this command to log in:`);
    console.log(`  ${CYAN}gog login your-email@gmail.com${RESET}`);
    console.log();
    console.log(`  This opens a browser to authorize gog. Once done, Max can`);
    console.log(`  access your Google services on your behalf.`);
    console.log();

    const googleEmail = await ask(
      rl,
      `  Google email ${DIM}(Enter to skip)${RESET}: `
    );

    if (googleEmail.trim()) {
      console.log(`\n  ${DIM}Run this now or later:${RESET}  ${CYAN}gog login ${googleEmail.trim()}${RESET}`);
      console.log(`  ${DIM}Check status anytime:${RESET}   ${CYAN}gog status${RESET}`);
    }

    console.log(`\n${GREEN}  ✓ Google skill is ready — authenticate with gog login when you're set.${RESET}\n`);
  } else {
    console.log(`\n${DIM}  Skipping Google. You can always set it up later with: max setup${RESET}\n`);
  }

  // ── Model picker ─────────────────────────────────────────
  console.log(`\n${BOLD}━━━ Default Model ━━━${RESET}\n`);
  console.log(`${DIM}You can switch models anytime by telling Max "switch to gpt-4.1"${RESET}\n`);

  const currentModel = existing.COPILOT_MODEL || "claude-sonnet-4.5";
  const model = await askPicker(rl, "Choose a default model:", MODELS, currentModel);
  const modelLabel = MODELS.find((m) => m.id === model)?.label || model;
  console.log(`\n${GREEN}  ✓ Using ${modelLabel}${RESET}\n`);

  // ── Write config ─────────────────────────────────────────
  const apiPort = existing.API_PORT || "7777";
  const lines: string[] = [];
  if (telegramToken) lines.push(`TELEGRAM_BOT_TOKEN=${telegramToken}`);
  if (userId) lines.push(`AUTHORIZED_USER_ID=${userId}`);
  lines.push(`API_PORT=${apiPort}`);
  lines.push(`COPILOT_MODEL=${model}`);

  writeFileSync(ENV_PATH, lines.join("\n") + "\n");

  // ── Done ─────────────────────────────────────────────────
  console.log(`
${GREEN}${BOLD}✅ Max is ready!${RESET}
${DIM}Config saved to ${ENV_PATH}${RESET}

${BOLD}Get started:${RESET}

  ${CYAN}1.${RESET} Make sure Copilot CLI is authenticated:
     ${BOLD}copilot login${RESET}

  ${CYAN}2.${RESET} Start Max:
     ${BOLD}max start${RESET}

  ${CYAN}3.${RESET} ${setupTelegram ? "Open Telegram and message your bot!" : "Connect via terminal:"}
     ${BOLD}${setupTelegram ? "(message your bot on Telegram)" : "max tui"}${RESET}

${BOLD}Things to try:${RESET}

  ${DIM}"Start working on the auth bug in ~/dev/myapp"${RESET}
  ${DIM}"What sessions are running?"${RESET}
  ${DIM}"Find me a skill for checking Gmail"${RESET}
  ${DIM}"Learn how to control my smart lights"${RESET}
  ${DIM}"Switch to gpt-4.1"${RESET}
`);

  rl.close();
}

main().catch((err) => {
  console.error("Setup failed:", err);
  process.exit(1);
});
