export type Provider = 'gemini' | 'openai' | 'anthropic' | 'ollama';

/** A cloud model (Gemini, Claude, an OpenAI-compatible service) - strong, with a big context - rather than the small local one. */
export function cloud(p: Provider | null | undefined): boolean {
  return Boolean(p) && p !== 'ollama';
}

export function providerName(p: Provider): string {
  return { gemini: 'Gemini', openai: 'the OpenAI-compatible model', anthropic: 'Claude', ollama: 'the local model' }[p];
}

export type AgentId = 'ultron' | 'athena' | 'argus' | 'hephaestus' | 'hermes' | 'chronos' | 'mnemosyne' | 'daedalus';

export interface JsonSchema {
  type: string;
  description?: string;
  properties?: Record<string, JsonSchema & Record<string, unknown>>;
  items?: JsonSchema;
  required?: string[];
  enum?: string[];
  [key: string]: unknown;
}

export interface ToolSpec {
  name: string;
  description: string;
  parameters: JsonSchema;
}

export interface ToolCall {
  id: string;
  name: string;
  args: Record<string, unknown>;
}

export type LlmMessage =
  | { role: 'user'; content: string; images?: { mimeType: string; data: string }[] }
  | { role: 'assistant'; content: string; toolCalls?: ToolCall[]; native?: unknown; nativeProvider?: Provider }
  | { role: 'tool'; callId: string; name: string; content: string };

/** main = the strongest brain available; fast = cheap background work (memory, news blurbs). */
export type Tier = 'main' | 'fast';
export type Effort = 'low' | 'medium' | 'high';

export interface ChatRequest {
  system: string;
  messages: LlmMessage[];
  tools?: ToolSpec[];
  temperature?: number;
  /** true = any JSON object; a schema = structured output against that schema. */
  json?: boolean | JsonSchema;
  think?: boolean;
  /** How hard the model should think: planning and reviewing high, background chores low. Unset = the model's default. */
  effort?: Effort;
  /** Worth the strongest (slower) model - Gemini Pro when the key allows it. */
  deep?: boolean;
  tier?: Tier;
  signal?: AbortSignal;
  onToken?: (token: string) => void;
  /** Called when the router falls back from one provider to another. */
  onNotice?: (text: string) => void;
}

export interface ChatResult {
  text: string;
  toolCalls: ToolCall[];
  native?: unknown;
  provider: Provider;
  model: string;
  /** Tokens this call used, when the provider reports them. */
  usage?: { input?: number; output?: number; thinking?: number };
}

export class LlmError extends Error {
  constructor(
    message: string,
    readonly kind: 'auth' | 'rate' | 'model' | 'network' | 'aborted' | 'other',
    readonly retryAfterMs?: number,
  ) {
    super(message);
    this.name = 'LlmError';
  }
}

export function newId(prefix = 'c'): string {
  return `${prefix}${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
}
