import type { Provider } from '../types';

/** How the HUD names each AI provider. */
export function providerLabel(p: Provider | null | undefined): string {
  switch (p) {
    case 'gemini': return 'Gemini';
    case 'anthropic': return 'Claude';
    case 'openai': return 'OpenAI-compatible';
    case 'ollama': return 'local';
    default: return 'none';
  }
}

/** Three letters for small gauges. */
export function providerShort(p: Provider | null | undefined): string {
  switch (p) {
    case 'gemini': return 'GEM';
    case 'anthropic': return 'CLD';
    case 'openai': return 'OAI';
    case 'ollama': return 'LOC';
    default: return 'OFF';
  }
}
