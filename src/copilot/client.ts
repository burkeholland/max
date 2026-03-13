/**
 * Backward-compatible Copilot client singleton.
 *
 * New code should depend on the ModelProvider interface and receive it
 * via dependency injection. This module exists only for legacy call-sites.
 */

import { CopilotProvider } from "../providers/copilot-provider.js";
import type { ModelProvider } from "../types/provider.js";

let provider: CopilotProvider | undefined;

/** Get (or create) the singleton CopilotProvider. */
export async function getProvider(): Promise<ModelProvider> {
  if (!provider) {
    provider = new CopilotProvider();
    await provider.start();
  }
  return provider;
}

/**
 * @deprecated Use getProvider() instead.
 * Kept for the few call-sites that still expect a CopilotClient.
 */
export async function getClient() {
  return getProvider();
}

/** Tear down the existing provider and create a fresh one. */
export async function resetClient(): Promise<ModelProvider> {
  if (provider) {
    return provider.reset();
  }
  return getProvider();
}

export async function stopClient(): Promise<void> {
  if (provider) {
    await provider.stop();
    provider = undefined;
  }
}

/** Read provider state without triggering startup work. */
export function getProviderState(): string {
  if (!provider) return "disconnected";
  return provider.getState();
}
