/**
 * The agent CLIs a summary can run on (#212). Each runs its own default model, so the app stores and
 * shows no model for one (ADR 0028 decision 7). An empty stored model used to be filled in with the
 * on-device default at load, and the toast then read "Using codex/gemma4:e2b" (#226).
 */
export const AGENT_CLI_NAMES = { 'claude-code': 'Claude Code', codex: 'Codex' } as const;

export type AgentCliProvider = keyof typeof AGENT_CLI_NAMES;

export function isAgentCliProvider(provider: string): provider is AgentCliProvider {
  return Object.prototype.hasOwnProperty.call(AGENT_CLI_NAMES, provider);
}

/**
 * The model a stored summary config loads as. An empty stored model falls back to the one already
 * held, except for an agent CLI, which keeps `''`.
 */
export function loadedSummaryModel(provider: string, stored: string, previous: string): string {
  return isAgentCliProvider(provider) ? '' : stored || previous;
}

/** What a summary runs on, as the toast names it: the CLI alone, or `provider/model`. */
export function summaryEngineLabel(provider: string, model: string): string {
  return isAgentCliProvider(provider) ? AGENT_CLI_NAMES[provider] : `${provider}/${model}`;
}
