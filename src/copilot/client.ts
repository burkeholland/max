import { CopilotClient } from "@github/copilot-sdk";

let client: CopilotClient | undefined;

/** Resolve an explicit GitHub token from env vars, if any. */
function resolveGithubToken(): string | undefined {
  return process.env.GITHUB_TOKEN || process.env.GH_TOKEN || undefined;
}

export async function getClient(): Promise<CopilotClient> {
  if (!client) {
    const githubToken = resolveGithubToken();
    client = new CopilotClient({
      autoStart: true,
      ...(githubToken ? { githubToken } : {}),
    });
    await client.start();
  }
  return client;
}

/** Tear down the existing client and create a fresh one. */
export async function resetClient(): Promise<CopilotClient> {
  if (client) {
    try { await client.stop(); } catch { /* best-effort */ }
    client = undefined;
  }
  return getClient();
}

export async function stopClient(): Promise<void> {
  if (client) {
    await client.stop();
    client = undefined;
  }
}
