import { getSettings } from './store';

export interface OllamaStatus {
  running: boolean;
  host: string;
  models: string[];
  activeModel: string;
  modelInstalled: boolean;
  error?: string;
}

function host(): string {
  return (getSettings().ollama.host || 'http://localhost:11434').replace(/\/$/, '');
}

/** Probes the local Ollama daemon. Never throws - the UI needs a verdict, not an exception. */
export async function status(): Promise<OllamaStatus> {
  const h = host();
  const model = getSettings().ollama.model;
  try {
    const res = await fetch(`${h}/api/tags`, { signal: AbortSignal.timeout(2500) });
    if (!res.ok) {
      return { running: false, host: h, models: [], activeModel: model, modelInstalled: false, error: `Ollama responded ${res.status}` };
    }
    const data = (await res.json()) as { models?: { name: string }[] };
    const models = (data.models ?? []).map((m) => m.name);
    // "qwen3.5" should match an installed "qwen3.5:latest", and "x:latest" should match "x".
    const bare = (n: string) => n.replace(/:latest$/, '');
    const modelInstalled = models.some((m) => bare(m) === bare(model));
    return { running: true, host: h, models, activeModel: model, modelInstalled };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return {
      running: false, host: h, models: [], activeModel: model, modelInstalled: false,
      error: /fetch failed|ECONNREFUSED|timeout/i.test(msg) ? 'Ollama is not running' : msg,
    };
  }
}

export interface PullProgress { model: string; status: string; completed?: number; total?: number; done?: boolean; error?: string }

/** Streams `ollama pull` progress through `onProgress`. Resolves once the model is fully present. */
export async function pullModel(model: string, onProgress: (p: PullProgress) => void): Promise<{ ok: boolean; error?: string }> {
  if (!/^[\w.\-:/]+$/.test(model)) return { ok: false, error: 'Invalid model name.' };
  try {
    const res = await fetch(`${host()}/api/pull`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, stream: true }),
    });
    if (!res.ok || !res.body) return { ok: false, error: `Ollama ${res.status}` };
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const j = JSON.parse(line) as { status?: string; completed?: number; total?: number; error?: string };
          if (j.error) { onProgress({ model, status: 'error', error: j.error }); return { ok: false, error: j.error }; }
          onProgress({ model, status: j.status ?? '', completed: j.completed, total: j.total });
        } catch { /* partial frame */ }
      }
    }
    onProgress({ model, status: 'success', done: true });
    return { ok: true };
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    onProgress({ model, status: 'error', error });
    return { ok: false, error };
  }
}
