import fs from 'node:fs';
import * as addons from '../../addons';
import * as hindsight from '../../hindsight';
import { getSecret } from '../../secrets';
import { getSettings } from '../../store';
import { activeGeminiModel, preferredProvider } from '../llm';
import { focusText } from '../passages';
import { record } from '../meter';
import { N, S, clip, num, obj, str, type AgentTool } from './types';

/*
 * The add-ons (addons.ts): browser-use, Agent-Reach's YouTube and RSS channels, Hindsight memory and the
 * scientific skills library. Each tool says plainly when its add-on isn't installed instead of failing obscurely.
 */

const hostOf = (url: string) => {
  try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return ''; }
};

export const addonTools: AgentTool[] = [
  {
    name: 'browser_agent',
    owner: 'daedalus',
    description: 'Hand a whole multi-step job on ONE website to an autonomous browser agent (browser-use): it navigates, clicks, fills search boxes, pages through results and reports what it found. Use it for jobs that take many steps on one site (compare items across pages, find something buried in menus, go through listings). It runs in a fresh browser that is logged in to nothing, stays on that site and never downloads. It cannot log in, buy, post or get past CAPTCHAs - do not ask it to.',
    parameters: obj({
      task: S('What to do and what to report, in full - it only sees this'),
      start_url: S('The page to start on (the agent stays on this site)'),
      max_steps: N('Step limit, default 20, max 40'),
    }, ['task', 'start_url']),
    label: (a) => `browser agent on ${hostOf(str(a, 'start_url'))}`,
    run: async (args, ctx) => {
      if (!fs.existsSync(addons.PATHS.browserUsePython)) return { error: 'The browser agent add-on (browser-use) is not installed.' };
      const start = str(args, 'start_url').trim();
      const host = hostOf(start);
      if (!/^https?:\/\//i.test(start) || !host) return { error: 'start_url must be a full http(s) address.' };
      const steps = Math.max(3, Math.min(40, num(args, 'max_steps', 20)));
      // It runs sandboxed - logged in to nothing, one site, no downloads - so by default it just runs (the operator
      // asked not to be asked every time); Apps -> Add-ons can turn the question back on.
      if (getSettings().addons.askBrowserAgent) {
        const ok = await ctx.approve(
          `web:browser-agent:${host}`,
          `Let the autonomous browser agent work on ${host}?`,
          `Task: ${str(args, 'task').slice(0, 600)}\n\nUp to ${steps} steps, in a fresh browser that is logged in to nothing and stays on ${host}. It is told never to log in, buy, post or get past a CAPTCHA.`,
        );
        if (!ok) return { error: 'The operator said no.' };
      }
      // The same AI the rest of Ultron is using right now; the local model only when that is all there is.
      const s = getSettings();
      const brain = await preferredProvider('main');
      const geminiModel = activeGeminiModel();
      const pick: { provider: 'gemini' | 'anthropic' | 'openai' | 'ollama'; model: string; key?: string; base_url?: string } =
        brain === 'gemini' && geminiModel ? { provider: 'gemini', model: geminiModel, key: getSecret('GEMINI_API_KEY') }
          : brain === 'anthropic' ? { provider: 'anthropic', model: s.anthropic.model, key: getSecret('ANTHROPIC_API_KEY') }
            : brain === 'openai' ? { provider: 'openai', model: s.openai.model, key: getSecret('OPENAI_API_KEY'), base_url: s.openai.baseUrl }
              : { provider: 'ollama', model: s.ollama.model };
      const job = {
        task: str(args, 'task'),
        start_url: start,
        allowed_domains: [host, `*.${host}`],
        max_steps: steps,
        provider: pick.provider,
        model: pick.model,
        base_url: pick.base_url,
        ollama_host: s.ollama.host,
        chrome: addons.chromiumPath(),
        vision: pick.provider !== 'ollama',
      };
      const keyEnv: Record<string, string> = pick.provider === 'gemini' ? { ULTRON_GEMINI_KEY: pick.key ?? '' } : pick.key ? { ULTRON_LLM_KEY: pick.key } : {};
      ctx.progress(`browser agent working on ${host} (up to ${steps} steps)`);
      const r = await addons.runPyTool<{ ok: boolean; final?: string; success?: boolean; urls?: string[]; steps?: number; seconds?: number; errors?: string[]; error?: string }>(
        addons.PATHS.browserUsePython, 'browser_agent.py', job,
        {
          // The key goes to the child process only, and only for this run. No Browser Use Cloud, no telemetry.
          env: { ...keyEnv, ANONYMIZED_TELEMETRY: 'false', BROWSER_USE_CLOUD_SYNC: 'false', BROWSER_USE_LOGGING_LEVEL: 'result' },
          timeoutMs: 7 * 60_000,
          signal: ctx.signal,
        },
      );
      // browser-use calls its model itself, one call per step - count them, so the request's cost line and limits are honest.
      if (r.ok && typeof r.steps === 'number') for (let i = 0; i < r.steps; i++) record(`browser-use/${job.model}`, {});
      if (!r.ok) return { error: `Browser agent failed: ${'error' in r ? r.error : 'unknown error'}` };
      return {
        result: r.final ?? '(no final report)',
        finished: r.success ?? false,
        pages_visited: r.urls,
        steps: r.steps,
        seconds: r.seconds,
        problems: r.errors?.length ? r.errors : undefined,
        brain: `${job.provider}/${job.model}`,
      };
    },
  },
  {
    name: 'youtube_transcript',
    owner: 'argus',
    description: 'A YouTube video\'s details and what is said in it (its English transcript) - by link, or the top result for a search like "kurzgesagt black holes". Use it to answer from a video, check what someone said, or summarise a lesson. (Agent-Reach\'s YouTube channel, via yt-dlp.)',
    parameters: obj({
      video: S('A YouTube link, or what to search for'),
      focus: S('Optional: what you need from it - a long transcript is cut down to the parts about it'),
    }, ['video']),
    label: (a) => `youtube transcript: ${str(a, 'video').slice(0, 60)}`,
    run: async (args, ctx) => {
      const v = await addons.youtube(str(args, 'video'), ctx.signal);
      if ('ok' in v) return { error: v.error };
      const budget = Math.max(1500, (ctx.resultBudget ?? 7000) - 900);
      const focus = str(args, 'focus').trim();
      const t = focus ? focusText(v.transcript, focus, budget).text : v.transcript.slice(0, budget);
      return {
        title: v.title, channel: v.channel, published: v.published, duration: v.duration, url: v.url,
        captions: v.captions,
        transcript: t || '(this video has no English captions)',
        transcript_cut: v.transcript.length > t.length || undefined,
      };
    },
  },
  {
    name: 'read_feed',
    owner: 'argus',
    description: 'The latest posts from an RSS or Atom feed (news sites, blogs, podcasts, YouTube channel feeds) - titles, links, dates and summaries. (Agent-Reach\'s RSS channel, via feedparser.)',
    parameters: obj({ url: S('The feed address'), limit: N('How many entries, default 15') }, ['url']),
    label: (a) => `read feed ${hostOf(str(a, 'url'))}`,
    run: async (args, ctx) => {
      const r = await addons.runPyTool<{ ok: boolean; feed?: string; site?: string; entries?: unknown[]; error?: string }>(
        addons.PATHS.agentReachPython, 'read_feed.py', { url: str(args, 'url'), limit: Math.min(40, num(args, 'limit', 15)) },
        { timeoutMs: 45_000, signal: ctx.signal },
      );
      return r.ok ? { feed: r.feed, site: r.site, entries: r.entries } : { error: 'error' in r ? r.error : 'The feed could not be read.' };
    },
  },
  {
    name: 'skill_search',
    owner: 'athena',
    description: 'Search the scientific skills library (K-Dense scientific-agent-skills: about 160 expert guides - statistics, data analysis and plots, literature review, chemistry, biology, genomics, physics, machine learning, lab protocols, scientific writing). Use it for a specialised science or data job, then read the best match with skill_read.',
    parameters: obj({ query: S('The job, e.g. "t-test between two groups", "plot a histogram", "balance a chemical equation"'), limit: N('Default 5') }, ['query']),
    label: (a) => `skills: ${str(a, 'query').slice(0, 60)}`,
    run: async (args) => {
      const hits = addons.searchSkills(str(args, 'query'), Math.min(10, num(args, 'limit', 5)));
      if (!hits.length) return addons.loadSkills().length ? { found: 0, note: 'No skill matches - do the job with your own tools.' } : { error: 'The scientific skills library is not installed.' };
      return { found: hits.length, skills: hits.map((s) => ({ name: s.name, about: s.description.slice(0, 300) })) };
    },
  },
  {
    name: 'skill_read',
    owner: 'athena',
    description: 'Read a skill from the scientific skills library: its guide (SKILL.md) or one of its reference files. Follow its method with your own tools. Its scripts need Python packages: only Hephaestus can run them, with run_command, which asks the operator first.',
    parameters: obj({ name: S('The skill name from skill_search'), file: S('Optional: another file in the skill, e.g. "references/methods.md"') }, ['name']),
    label: (a) => `read skill ${str(a, 'name')}${str(a, 'file') ? `/${str(a, 'file')}` : ''}`,
    run: async (args, ctx) => {
      const r = addons.readSkill(str(args, 'name'), str(args, 'file') || undefined);
      if ('error' in r) return r;
      return { skill: r.name, text: clip(r.text, Math.max(2000, (ctx.guideBudget ?? ctx.resultBudget ?? 7000) - 800)), other_files: r.files.filter((f) => f !== 'SKILL.md').slice(0, 30) };
    },
  },
  {
    name: 'memory_reflect',
    owner: 'mnemosyne',
    description: 'Ask Hindsight - Ultron\'s second long-term memory, which learns from every conversation - to think over what it knows and answer a question about the operator ("what have I been struggling with in math?", "what do I usually do before games?"). Slower than memory_search; use it for questions that need memories put together.',
    parameters: obj({ question: S('The question to reflect on') }, ['question']),
    label: (a) => `reflect: ${str(a, 'question').slice(0, 60)}`,
    run: async (args, ctx) => {
      const r = await hindsight.reflect(str(args, 'question'), ctx.signal);
      return 'error' in r ? r : { answer: clip(r.text, 4000), based_on: r.basedOn };
    },
  },
];

export const ADDON_READS = ['youtube_transcript', 'read_feed', 'skill_search', 'skill_read', 'memory_reflect'];
