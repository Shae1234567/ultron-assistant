import { shell } from 'electron';
import * as browser from '../../browser';
import * as research from '../../research';
import { findFlights } from '../../flightFinder';
import { getSettings } from '../../store';
import { chat, groundedSearch } from '../llm';
import { deepResearch, type Depth } from '../deepResearch';
import { focusText } from '../passages';
import { workflow } from '../workflow';
import { N, S, B, bool, clip, num, obj, str, type AgentTool, type ToolContext } from './types';
import { judgeClick, judgeKeys, judgeSubmit, judgeTyping, type Verdict } from '../webSafety';

function snapshotText(s: browser.Snapshot): unknown {
  if (!s.ok) return { error: s.error };
  return {
    url: s.url,
    title: s.title,
    warning: s.warning,
    on_screen: s.visible_text,
    links_on_screen: s.links?.length ? s.links.join('\n') : undefined,
    scroll: s.scroll ? `${s.scroll.percent}% down the page${s.scroll.atBottom ? ' (at the bottom)' : ''}` : undefined,
    elements: (s.elements ?? []).join('\n'),
    hint: 'Click or type with an element number (numbers change after every page change). browser_scroll for more of a feed, browser_read for all the text, browser_look to see images, video thumbnails and layout.',
  };
}

/** Whether the model actually passed an argument (0 is a real element number). */
function args_has(args: Record<string, unknown>, key: string): boolean {
  return args[key] !== undefined && args[key] !== null && args[key] !== '';
}

/** Applies a safety verdict: blocked actions return why; risky ones wait for the operator's Approve. */
async function gate(ctx: ToolContext, v: Verdict, target: browser.Target | null): Promise<{ error: string } | null> {
  if (v.kind === 'allow') return null;
  if (v.kind === 'block') return { error: v.reason };
  const detail = [v.what, 'This happens in your signed-in browser, so it is real.', target?.url ? `Page: ${target.url}` : ''].filter(Boolean).join('\n\n');
  const ok = await ctx.approve(`web:${v.verb}:${target?.host ?? ''}`, `Let Ultron ${v.what}?`, detail);
  return ok ? null : { error: 'The operator said no. Do not try another way - report what is left for them to do.' };
}

const host = (url: string) => url.replace(/^https?:\/\/(www\.)?/, '').slice(0, 60);

export const webTools: AgentTool[] = [
  {
    name: 'google_search',
    owner: 'argus',
    description: 'Ask Google: Gemini searches Google and answers with its sources. The fastest, most reliable way to get current facts - news, scores, prices, release dates, "who is", "what happened", "is X still true". Ask one clear question. Check the sources it returns; open one with read_webpage when details matter.',
    parameters: obj({ question: S('A complete question, e.g. "Who won the Lakers game last night and what was the score?"') }, ['question']),
    label: (a) => `google "${str(a, 'question').slice(0, 70)}"`,
    run: async (args, ctx) => {
      try {
        const r = await groundedSearch(str(args, 'question'), ctx.signal);
        if (!r.answer) return { error: 'Google Search returned no answer - try web_search.' };
        return { answer: clip(r.answer, 6000), sources: r.sources, searched_for: r.queries.length ? r.queries : undefined };
      } catch (e) {
        return { error: `${e instanceof Error ? e.message : String(e)} Use web_search instead.` };
      }
    },
  },
  {
    name: 'web_search',
    owner: 'argus',
    description: 'Search the web in your own browser tab (Bing, Startpage, Yahoo, DuckDuckGo or Brave - engines that refuse automated searches are skipped for a while). Returns titles, URLs and snippets - then open the promising ones. Use several focused queries rather than one vague one.',
    parameters: obj({
      query: S('Search query'),
      engine: S('auto (default), bing, startpage, yahoo, duckduckgo or brave', { enum: ['auto', ...browser.ENGINE_ORDER] }),
      limit: N('Max results (default 8)'),
    }, ['query']),
    label: (a) => `search "${str(a, 'query')}"`,
    run: async (args, ctx) => {
      const engine = str(args, 'engine', 'auto') as browser.Engine | 'auto';
      const r = await browser.search(ctx.tab, str(args, 'query'), (browser.ENGINE_ORDER as string[]).includes(engine) ? engine : 'auto', num(args, 'limit', 8));
      return r.ok ? { engine: r.engine, results: r.results } : { error: r.error };
    },
  },
  {
    name: 'read_webpage',
    owner: 'argus',
    description: 'Open a URL in your browser tab and read it in one step - the fastest way to get a page\'s content. mode "article" (default) = the main story; mode "page" = everything on it plus its real links, for front pages, feeds, rankings, search results, threads and listings.',
    parameters: obj({
      url: S('http(s) URL'),
      mode: S('article (default) or page', { enum: ['article', 'page'] }),
      max_chars: N('Default 8000'),
      focus: S('What you are looking for on the page, e.g. "when are tryout results posted". A long page is then cut down to the parts about it instead of just its start - use it for long articles, reports, rule books and schedules.'),
    }, ['url']),
    label: (a) => `read ${host(str(a, 'url'))}${str(a, 'mode') === 'page' ? ' (all)' : ''}`,
    run: async (args, ctx) => {
      const opened = await browser.open(ctx.tab, str(args, 'url'));
      if (!opened.ok) return { error: opened.error, url: str(args, 'url') };
      const max = Math.min(num(args, 'max_chars', 8000), 20_000);
      const focus = workflow().research2 ? str(args, 'focus').trim() : '';
      const r = await browser.read(ctx.tab, str(args, 'mode') === 'page' ? 'page' : 'article', focus ? 40_000 : max);
      // Fit the chosen passages inside what the caller will see - a small local model's results are clipped to
      // about 2,800 characters, which cut an answer out of the middle of an 8,000-character selection.
      const fit = Math.max(1200, Math.min(max, (ctx.resultBudget ?? max) - 500));
      const f = r.ok && focus && r.text ? focusText(r.text, focus, fit, Math.min(600, fit / 4)) : null;
      return r.ok
        ? { url: r.url, title: r.title, byline: r.byline, warning: r.warning ?? opened.warning, guessed: opened.guessed, text: f ? f.text : r.text, truncated: f ? f.focused : r.truncated, focused_on: f?.focused ? `${f.kept} of ${f.total} passages about "${focus.slice(0, 80)}"` : undefined }
        : { error: r.error, url: r.url };
    },
  },
  {
    name: 'deep_research',
    owner: 'argus',
    description: 'Background multi-source research pipeline: covers the question from several perspectives, reads the best pages in parallel, follows up on conflicts and gaps, and writes a cited brief with dated sources and a check that each citation really is in its source (saved to the vault\'s Research folder). Good for a solid, sourced answer; for live, trending or social content, browse yourself or send helpers.',
    parameters: obj({
      question: S('The full research question, specific'),
      depth: S('quick (about 4 sources), standard (about 7 plus a follow-up round) or deep (10 plus a bigger follow-up round). Leave it out to use the operator\'s default from Settings.', { enum: ['quick', 'standard', 'deep'] }),
    }, ['question']),
    label: (a) => `deep research: ${str(a, 'question').slice(0, 70)}`,
    run: async (args, ctx) => {
      const depthArg = str(args, 'depth', getSettings().research.depth);
      const depth: Depth = depthArg === 'quick' || depthArg === 'deep' ? depthArg : 'standard';
      const r = await deepResearch(str(args, 'question'), { depth, signal: ctx.signal, progress: ctx.progress });
      if (!r.ok) return { error: r.error };
      return { saved_to_vault: r.notePath, sources: r.sources, report: clip(r.report, 9000), verification: r.verification };
    },
  },
  {
    name: 'browser_open',
    owner: 'argus',
    description: 'Open any page in your own browser tab - a site\'s home page, a subreddit, a trending page, a search. Returns what is on screen and the clickable elements, numbered.',
    parameters: obj({ url: S('http(s) URL') }, ['url']),
    label: (a) => `open ${host(str(a, 'url'))}`,
    run: async (args, ctx) => snapshotText(await browser.open(ctx.tab, str(args, 'url'))),
  },
  {
    name: 'browser_click',
    owner: 'argus',
    description: 'Click a numbered element on your open page (a link, button, tab, menu item, "more comments"...). Clicks that post, send, share, delete or confirm ask the operator first; buying and creating accounts are not allowed.',
    parameters: obj({ element: N('Element number from the latest look at the page') }, ['element']),
    label: (a) => `click [${num(a, 'element', 0)}]`,
    run: async (args, ctx) => {
      const ref = num(args, 'element', 0);
      const target = await browser.describeRef(ctx.tab, ref);
      const stop = await gate(ctx, judgeClick(target), target);
      return stop ?? snapshotText(await browser.click(ctx.tab, ref));
    },
  },
  {
    name: 'browser_type',
    owner: 'argus',
    description: 'Type text. With an element number: form fields are filled (replacing their text unless append is true); code editors, rich editors and anything else are clicked into and typed into - so to write in an editor, give its number and the whole text in ONE call (no separate click needed). Without an element: types into whatever has focus. Long text and code go in at once. Never for passwords or card numbers.',
    parameters: obj({
      element: N('Optional element number; leave out to type into the focused spot'),
      text: S('Text to type (newlines allowed)'),
      submit: B('Press Enter afterwards (a search box, a single-line form)'),
      append: B('Add to what is already in the field instead of replacing it'),
    }, ['text']),
    label: (a) => `type "${str(a, 'text').replace(/\s+/g, ' ').slice(0, 40)}"${args_has(a, 'element') ? ` into [${num(a, 'element', 0)}]` : ''}`,
    run: async (args, ctx) => {
      const ref = args_has(args, 'element') ? num(args, 'element', 0) : null;
      const target = ref !== null ? await browser.describeRef(ctx.tab, ref) : await browser.describeFocused(ctx.tab);
      const text = str(args, 'text');
      const stop = (await gate(ctx, judgeTyping(target, text), target)) ?? (bool(args, 'submit') ? await gate(ctx, judgeSubmit(target), target) : null);
      return stop ?? snapshotText(await browser.type(ctx.tab, ref, text, bool(args, 'submit'), bool(args, 'append')));
    },
  },
  {
    name: 'browser_scroll',
    owner: 'argus',
    description: 'Scroll your open page (feeds load more as you go). Returns what is on screen after scrolling.',
    parameters: obj({
      direction: S('down (default) or up', { enum: ['down', 'up'] }),
      screens: N('How far, in screens (default 1, max 6)'),
    }),
    label: (a) => `scroll ${str(a, 'direction', 'down')}`,
    run: async (args, ctx) => snapshotText(await browser.scroll(ctx.tab, str(args, 'direction') === 'up' ? 'up' : 'down', num(args, 'screens', 1))),
  },
  {
    name: 'browser_back',
    owner: 'argus',
    description: 'Go back one page in your browser tab.',
    parameters: obj({}),
    label: () => 'back',
    run: async (_args, ctx) => snapshotText(await browser.back(ctx.tab)),
  },
  {
    name: 'browser_read',
    owner: 'argus',
    description: 'Read the text of your open page. mode "article" = the main story only; mode "page" = everything loaded (feeds, threads, comments, listings, rankings). Give a focus (what you are looking for) and a long page is cut to the parts about it.',
    parameters: obj({
      mode: S('article (default) or page', { enum: ['article', 'page'] }),
      max_chars: N('Default 8000'),
      focus: S('What you are looking for on the page'),
    }),
    label: (a) => `read page${str(a, 'mode') === 'page' ? ' (all)' : ''}`,
    run: async (args, ctx) => {
      const max = Math.min(num(args, 'max_chars', 8000), 20_000);
      const focus = workflow().research2 ? str(args, 'focus').trim() : '';
      const r = await browser.read(ctx.tab, str(args, 'mode') === 'page' ? 'page' : 'article', focus ? 40_000 : max);
      if (!r.ok) return { error: r.error };
      // Same as read_webpage: the passages about the question, sized to what the caller will actually see.
      const fit = Math.max(1200, Math.min(max, (ctx.resultBudget ?? max) - 500));
      const f = focus && r.text ? focusText(r.text, focus, fit, Math.min(600, fit / 4)) : null;
      return { url: r.url, title: r.title, warning: r.warning, text: f ? f.text : r.text, truncated: f ? f.focused : r.truncated, focused_on: f?.focused ? `${f.kept} of ${f.total} passages about "${focus.slice(0, 80)}"` : undefined };
    },
  },
  {
    name: 'browser_find',
    owner: 'argus',
    description: 'Find text on your open page (like Ctrl+F). Returns each match with its surroundings and scrolls to the first one.',
    parameters: obj({ text: S('Word or phrase to find') }, ['text']),
    label: (a) => `find "${str(a, 'text').slice(0, 40)}"`,
    run: async (args, ctx) => {
      const r = await browser.find(ctx.tab, str(args, 'text'));
      return r.ok ? { matches: r.hits?.length ? r.hits : 'no matches on this page' } : { error: r.error };
    },
  },
  {
    name: 'browser_links',
    owner: 'argus',
    description: 'List the links on your open page (text + URL), nearest the screen first, optionally filtered by a word - quicker than scrolling to find where to go next.',
    parameters: obj({ filter: S('Optional word the link text or URL must contain') }),
    label: (a) => `links${str(a, 'filter') ? ` "${str(a, 'filter')}"` : ''}`,
    run: async (args, ctx) => {
      const r = await browser.links(ctx.tab, str(args, 'filter'));
      return r.ok ? { page: r.url, links: r.links } : { error: r.error };
    },
  },
  {
    name: 'browser_look',
    owner: 'argus',
    description: 'Look at your open page with your eyes (a screenshot read by the vision model) and answer a question about it - images, thumbnails, charts, video pages, view and like counts, visual layouts, canvas editors. Clickable elements wear yellow number tags (the numbers browser_click takes) and a pink grid marks 100-px coordinates for browser_mouse - ask things like "which number is the Share button?" or "where on the canvas is the title text (x,y)?".',
    parameters: obj({
      question: S('What to look for or answer'),
      marks: B('Number tags and coordinate grid (default true)'),
    }, ['question']),
    label: (a) => `look: ${str(a, 'question').slice(0, 50)}`,
    run: async (args, ctx) => {
      const shot = await browser.screenshot(ctx.tab, bool(args, 'marks', true));
      if (!shot.ok || !shot.data) return { error: shot.error ?? 'Could not capture the page.' };
      const res = await chat({
        system: [
          'You are looking at a screenshot of a web page an agent has open. Answer from what is actually visible: quote text, numbers (views, likes, dates), names and what images show. Say plainly when something is not visible - never guess.',
          'Yellow tags with numbers mark clickable elements - when asked where to click, give the tag number. Pink dashed lines are a coordinate grid every 100 px (x across the top, y down the left) on a 1280 x 800 page - when something has no tag (a canvas, a drawing area), give its approximate x,y from the grid.',
        ].join('\n'),
        messages: [{ role: 'user', content: `Page: ${shot.title} (${shot.url})\nQuestion: ${str(args, 'question') || 'What is on this page?'}`, images: [{ mimeType: 'image/jpeg', data: shot.data }] }],
        temperature: 0.2,
        signal: ctx.signal,
      });
      return { answer: res.text, url: shot.url, seen_by: res.provider, elements: shot.elements?.join('\n') };
    },
  },
  {
    name: 'browser_press',
    owner: 'argus',
    description: 'Press keys or shortcuts on your open page, in order, space-separated: "Enter", "Tab", "Escape", "ArrowDown", "Control+A", "Control+B", "Control+Z", "Shift+Tab". Editors are fastest with shortcuts. Enter in a message box and Delete on a selected item ask the operator first.',
    parameters: obj({ keys: S('e.g. "Control+A Delete" or "Tab Tab Enter"') }, ['keys']),
    label: (a) => `press ${str(a, 'keys').slice(0, 40)}`,
    run: async (args, ctx) => {
      const keys = str(args, 'keys');
      const focused = await browser.describeFocused(ctx.tab);
      const stop = await gate(ctx, judgeKeys(keys, focused), focused);
      return stop ?? snapshotText(await browser.press(ctx.tab, keys));
    },
  },
  {
    name: 'browser_mouse',
    owner: 'argus',
    description: 'Use the mouse at page coordinates (the 1280 x 800 page; get positions from browser_look\'s grid) - for canvas apps and drawing areas with no numbered elements: click, double_click, right_click, move, drag (x,y to to_x,to_y - drawing shapes, moving things, resizing) or scroll (amount in px, negative scrolls up).',
    parameters: obj({
      action: S('click, double_click, right_click, move, drag or scroll', { enum: ['click', 'double_click', 'right_click', 'move', 'drag', 'scroll'] }),
      x: N('x (0-1280)'),
      y: N('y (0-800)'),
      to_x: N('drag end x'),
      to_y: N('drag end y'),
      amount: N('scroll amount in px (default 500)'),
    }, ['action', 'x', 'y']),
    label: (a) => `${str(a, 'action', 'click').replace('_', ' ')} at ${num(a, 'x', 0)},${num(a, 'y', 0)}`,
    run: async (args, ctx) => {
      const action = str(args, 'action', 'click') as browser.MouseAction;
      const x = num(args, 'x', -1);
      const y = num(args, 'y', -1);
      if (action === 'click' || action === 'double_click') {
        const target = await browser.describePoint(ctx.tab, x, y);
        const stop = await gate(ctx, judgeClick(target), target);
        if (stop) return stop;
      }
      return snapshotText(await browser.mouse(ctx.tab, action, x, y, args_has(args, 'to_x') ? num(args, 'to_x', 0) : undefined, args_has(args, 'to_y') ? num(args, 'to_y', 0) : undefined, args_has(args, 'amount') ? num(args, 'amount', 500) : undefined));
    },
  },
  {
    name: 'browser_select',
    owner: 'argus',
    description: 'Pick an option in a numbered dropdown (<select>) by its visible text.',
    parameters: obj({ element: N('Element number of the dropdown'), option: S('The option\'s visible text') }, ['element', 'option']),
    label: (a) => `choose "${str(a, 'option').slice(0, 30)}" in [${num(a, 'element', 0)}]`,
    run: async (args, ctx) => snapshotText(await browser.select(ctx.tab, num(args, 'element', 0), str(args, 'option'))),
  },
  {
    name: 'browser_hover',
    owner: 'argus',
    description: 'Hover over a numbered element - to open a menu or reveal buttons that only appear on hover.',
    parameters: obj({ element: N('Element number') }, ['element']),
    label: (a) => `hover [${num(a, 'element', 0)}]`,
    run: async (args, ctx) => snapshotText(await browser.hover(ctx.tab, num(args, 'element', 0))),
  },
  {
    name: 'browser_wait',
    owner: 'argus',
    description: 'Wait for text to appear on the page (e.g. "Saved", a result, an editor finishing loading) - or, without text, just a few seconds.',
    parameters: obj({ text: S('Optional text to wait for'), seconds: N('Longest to wait (default 3, max 20)') }),
    label: (a) => (str(a, 'text') ? `wait for "${str(a, 'text').slice(0, 30)}"` : `wait ${num(a, 'seconds', 3)}s`),
    run: async (args, ctx) => snapshotText(await browser.waitFor(ctx.tab, str(args, 'text'), num(args, 'seconds', 3))),
  },
  {
    name: 'youtube_search',
    owner: 'argus',
    description: 'Search YouTube and return real video links (title, URL, channel).',
    parameters: obj({ query: S('What to search for'), limit: N('Default 6') }, ['query']),
    label: (a) => `youtube "${str(a, 'query')}"`,
    run: async (args) => {
      const r = await browser.youtubeSearch(str(args, 'query'), num(args, 'limit', 6));
      return r.ok ? { results: r.results } : { error: r.error };
    },
  },
  {
    name: 'play_on_youtube',
    owner: 'argus',
    description: 'Find a video on YouTube and open it in the operator\'s real browser so it plays for them.',
    parameters: obj({ query: S('Song, video or channel to play') }, ['query']),
    label: (a) => `play "${str(a, 'query')}" on YouTube`,
    run: async (args) => {
      const r = await browser.youtubeSearch(str(args, 'query'), 1);
      const top = r.ok ? r.results[0] : undefined;
      if (!top) return { error: r.error ?? 'No matching video found.' };
      await shell.openExternal(top.url);
      return { ok: true, playing: top.title, channel: top.channel, url: top.url };
    },
  },
  {
    name: 'encyclopedia_lookup',
    owner: 'argus',
    description: 'Quick fact lookup across Wikipedia, Wikidata and DuckDuckGo instant answers. Good for stable background facts; use web_search for anything recent.',
    parameters: obj({ query: S('Topic') }, ['query']),
    label: (a) => `lookup "${str(a, 'query')}"`,
    run: async (args) => {
      const results = await research.research(str(args, 'query'));
      return results.length ? { results } : { error: 'Nothing found.' };
    },
  },
  {
    name: 'get_weather',
    owner: 'argus',
    description: 'Current live weather for a place (defaults to the operator\'s location).',
    parameters: obj({ place: S('Place name (optional)') }),
    label: (a) => `weather ${str(a, 'place') || 'here'}`,
    run: async (args) => {
      const place = str(args, 'place') || getSettings().profile.location;
      const w = await research.getWeather(place);
      return w ?? { error: `Could not get weather for ${place}.` };
    },
  },
  {
    name: 'on_this_day',
    owner: 'argus',
    description: 'Historical events that happened on today\'s date (oldest first).',
    parameters: obj({}),
    label: () => 'on this day',
    run: async () => {
      const events = await research.getOnThisDay();
      return events.length ? { events } : { error: 'The feed returned nothing.' };
    },
  },
  {
    name: 'find_flights',
    owner: 'argus',
    description: 'Best-effort live Google Flights lookup for a route and date. Results are scraped text, so verify before relying on them.',
    parameters: obj({ origin: S('From city/airport'), destination: S('To city/airport'), date: S('Travel date, e.g. 2026-10-12') }, ['origin', 'destination', 'date']),
    label: (a) => `flights ${str(a, 'origin')} -> ${str(a, 'destination')}`,
    run: async (args) => findFlights(str(args, 'origin'), str(args, 'destination'), str(args, 'date')),
  },
];
