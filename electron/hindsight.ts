import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { app } from 'electron';
import { HindsightClient } from '@vectorize-io/hindsight-client';
import { PATHS } from './addons';
import { getSettings } from './store';
import { redactSecrets } from './memory/redact';

/**
 * Hindsight (github.com/vectorize-io/hindsight, MIT): a long-term memory
 * that extracts facts from what it is given, links them, and can "reflect"
 * over them - run beside Ultron's Obsidian vault, not instead of it. The
 * vault stays the source of truth the operator can read and edit; Hindsight
 * is a second, learning index over the same conversations.
 *
 * It runs as a local server Ultron starts on first use and stops on quit:
 *  - bound to 127.0.0.1 only (its default, 0.0.0.0, would expose the memory to the local network);
 *  - its model is the local one (Ollama), so memories never leave the PC and cost no Gemini quota;
 *  - embeddings via ONNX on the CPU; database: its embedded PostgreSQL (~/.pg0), also local-only.
 * Secrets are redacted before anything is retained.
 */

const PORT = 18888;
const BASE = `http://127.0.0.1:${PORT}`;

/* One server per PC, one memory bank per Ultron profile - the installed app's is "ultron"; a development or test
   profile gets its own, so test conversations never land in the operator's memory. */
let bankId = '';
function bank(): string {
  if (bankId) return bankId;
  if (app.isPackaged) return (bankId = 'ultron');
  const hash = createHash('sha256').update(app.getPath('userData').toLowerCase()).digest('hex').slice(0, 10);
  return (bankId = `ultron-dev-${hash}`);
}

let proc: ChildProcess | null = null;
let starting: Promise<boolean> | null = null;
let lastError = '';
const client = new HindsightClient({ baseUrl: BASE });

export function installed(): boolean {
  return fs.existsSync(PATHS.hindsight);
}

export function enabled(): boolean {
  return getSettings().addons.hindsight && installed();
}

async function healthy(): Promise<boolean> {
  try {
    const r = await fetch(`${BASE}/health`, { signal: AbortSignal.timeout(2000) });
    return r.ok;
  } catch {
    return false;
  }
}

/** Starts the server if it isn't running; resolves true once it answers (the first start takes a minute or two). */
export function ensureRunning(): Promise<boolean> {
  if (!enabled()) return Promise.resolve(false);
  if (starting) return starting;
  starting = (async () => {
    if (await healthy()) return true;
    const s = getSettings();
    proc = spawn(PATHS.hindsight, ['--host', '127.0.0.1', '--port', String(PORT), '--log-level', 'warning'], {
      windowsHide: true,
      env: {
        ...process.env,
        PYTHONUTF8: '1',
        PYTHONIOENCODING: 'utf-8',
        HINDSIGHT_API_LLM_PROVIDER: 'ollama',
        HINDSIGHT_API_LLM_BASE_URL: `${s.ollama.host.replace(/\/$/, '')}/v1`,
        HINDSIGHT_API_LLM_MODEL: s.ollama.model,
        HINDSIGHT_API_EMBEDDINGS_PROVIDER: 'onnx',
        HINDSIGHT_API_RERANKER_PROVIDER: 'rrf',
      },
    });
    proc.stderr?.on('data', (d: Buffer) => { lastError = d.toString('utf8').trim().split(/\r?\n/).pop()?.slice(0, 300) ?? lastError; });
    proc.on('exit', () => { proc = null; starting = null; });
    for (let i = 0; i < 90; i++) {
      await new Promise((r) => setTimeout(r, 2000));
      if (await healthy()) return true;
      if (!proc) break;
    }
    return false;
  })();
  starting.then((ok) => { if (!ok) starting = null; }, () => { starting = null; });
  return starting;
}

/**
 * Stops the server AND its embedded PostgreSQL. Killing the server alone leaves ten idle postgres processes
 * running (found in testing, 29 Sep 2026), so the database is stopped through pg0 itself.
 */
export function stop(): void {
  const wasRunning = Boolean(proc);
  if (proc) {
    try { proc.kill(); } catch { /* gone */ }
    proc = null;
  }
  starting = null;
  const python = path.join(path.dirname(PATHS.hindsight), 'python.exe');
  if (wasRunning && fs.existsSync(python)) {
    try {
      spawnSync(python, ['-c', "import pg0\ntry:\n    pg0.stop('hindsight')\nexcept Exception:\n    pass"], { windowsHide: true, timeout: 15_000 });
    } catch { /* best effort on the way out */ }
  }
}

export async function status(): Promise<{ installed: boolean; enabled: boolean; running: boolean; error?: string }> {
  return { installed: installed(), enabled: enabled(), running: await healthy(), error: lastError || undefined };
}

/** Remembers one exchange (in the background - Hindsight extracts facts with the local model). */
export async function retain(text: string, at: Date, context: string): Promise<void> {
  if (!(await ensureRunning())) return;
  await client.retain(bank(), redactSecrets(text), { timestamp: at, context, async: true });
}

export interface Recalled { text: string; type?: string; when?: string }

export async function recall(query: string, limit = 6, signal?: AbortSignal): Promise<Recalled[]> {
  if (!enabled() || !(await healthy())) return [];
  const r = await client.recall(bank(), query, { maxTokens: 1500, signal });
  return (r.results ?? []).slice(0, limit).map((x) => ({ text: x.text, type: x.type ?? undefined, when: x.mentioned_at ?? x.occurred_start ?? undefined }));
}

export async function reflect(question: string, signal?: AbortSignal): Promise<{ text: string; basedOn?: number } | { error: string }> {
  if (!installed()) return { error: 'The Hindsight memory add-on is not installed.' };
  if (!getSettings().addons.hindsight) return { error: 'Hindsight memory is switched off in Apps -> Add-ons.' };
  if (!(await ensureRunning())) return { error: `Hindsight memory is not running${lastError ? `: ${lastError}` : '.'}` };
  try {
    const r = await client.reflect(bank(), question, { signal });
    const facts = (r.based_on as { memories?: unknown[] } | null | undefined)?.memories;
    return { text: r.text, basedOn: Array.isArray(facts) ? facts.length : undefined };
  } catch (e) {
    return { error: `Hindsight could not reflect: ${e instanceof Error ? e.message : String(e)}` };
  }
}
