import { shell } from 'electron';
import * as systemControl from '../../systemControl';
import * as spotify from '../../spotifyLocal';
import * as windowSwitch from '../../windowSwitch';
import { takeScreenshotAndSave } from '../../screenshot';
import { captureScreen } from '../../vision';
import { getHardwareStats } from '../../hardwareStats';
import { getBatteryInfo } from '../../batteryInfo';
import { getIpInfo } from '../../ipInfo';
import { evaluate } from '../../calculator';
import { evaluateMath, runCode } from '../../sandbox';
import { workflow } from '../workflow';
import * as wolfram from '../../wolframAlpha';
import { distanceToPlace } from '../../geocode';
import { chat } from '../llm';
import { N, S, obj, str, type AgentTool } from './types';

export const systemTools: AgentTool[] = [
  {
    name: 'open_app',
    owner: 'hephaestus',
    description: 'Launch an application on the operator\'s PC by name (e.g. "notepad", "spotify", "chrome", "calc", "discord").',
    parameters: obj({ name: S('App name or full path') }, ['name']),
    label: (a) => `launch ${str(a, 'name')}`,
    run: async (args) => systemControl.openApp(str(args, 'name')),
  },
  {
    name: 'open_url',
    owner: 'hephaestus',
    description: 'Open a web page in the operator\'s real browser so they can see it.',
    parameters: obj({ url: S('http(s) URL') }, ['url']),
    label: (a) => `open ${str(a, 'url').replace(/^https?:\/\/(www\.)?/, '').slice(0, 60)}`,
    run: async (args) => {
      const url = str(args, 'url');
      if (!/^https?:\/\//i.test(url)) return { error: 'Only http(s) links can be opened.' };
      await shell.openExternal(url);
      return { ok: true, opened: url };
    },
  },
  {
    name: 'set_volume',
    owner: 'hephaestus',
    description: 'Turn the system volume up, down, or toggle mute.',
    parameters: obj({ direction: S('up, down or mute', { enum: ['up', 'down', 'mute'] }), steps: N('How many notches (1-10, default 3)') }, ['direction']),
    label: (a) => `volume ${str(a, 'direction')}`,
    run: async (args) => {
      const dir = str(args, 'direction') as 'up' | 'down' | 'mute';
      if (!['up', 'down', 'mute'].includes(dir)) return { error: 'direction must be up, down or mute' };
      const steps = dir === 'mute' ? 1 : Math.min(Math.max(Math.round(Number(args.steps) || 3), 1), 10);
      for (let i = 0; i < steps; i++) {
        const r = await systemControl.setVolume(dir);
        if (!r.ok) return r;
      }
      return { ok: true, direction: dir, steps };
    },
  },
  {
    name: 'spotify',
    owner: 'hephaestus',
    description: 'The Spotify app on this PC (works with Spotify Free). now_playing: what song is on. play: resume (opens Spotify if it is closed). pause, next, previous. open: show a song, artist, album or playlist in Spotify - give query (e.g. "travis scott", "lofi beats") or a Spotify link; the operator then presses play on the one they want, because only Spotify\'s paid API can start an exact song. For "play <something>", use open and say so - do not call play after it (play resumes the last song, not the one opened). Volume is set_volume.',
    parameters: obj({ action: S('now_playing, play, pause, next, previous or open', { enum: ['now_playing', 'play', 'pause', 'next', 'previous', 'open'] }), query: S('For open: what to find, or a Spotify link') }, ['action']),
    label: (a) => (str(a, 'action') === 'open' ? `open in spotify: ${str(a, 'query')}` : `spotify ${str(a, 'action').replace('_', ' ')}`),
    run: async (args) => {
      const action = str(args, 'action');
      try {
        if (action === 'open') {
          const query = str(args, 'query').trim();
          if (!query) return { error: 'Say what to open in Spotify (a song, artist, playlist or a Spotify link).' };
          const r = await spotify.openInSpotify(query);
          return { ok: true, opened_in_spotify: r.opened, note: 'Spotify now shows it - the operator presses play on the exact song (Spotify Free cannot be told to start one).' };
        }
        const map: Record<string, spotify.SpotifyAction> = { now_playing: 'status', play: 'play', pause: 'pause', next: 'next', previous: 'previous' };
        if (!map[action]) return { error: 'action must be now_playing, play, pause, next, previous or open' };
        const s = await spotify.control(map[action]);
        if (!s.session) {
          return { error: s.opened ? 'Spotify opened but has nothing loaded yet - pick something in it first (or ask me to open a song).' : 'Spotify is not open - nothing is playing in it.' };
        }
        const song = s.title ? `${s.title}${s.artist ? ` - ${s.artist}` : ''}` : undefined;
        return { ok: s.ok !== false, ...(s.opened ? { opened_spotify: true } : {}), now: song, state: s.status };
      } catch (e) {
        return { error: e instanceof Error ? e.message : String(e) };
      }
    },
  },
  {
    name: 'lock_computer',
    owner: 'hephaestus',
    description: 'Lock the PC (Windows lock screen). Only when the operator explicitly asks. Asks for approval.',
    parameters: obj({}),
    label: () => 'lock the PC',
    run: async (_args, ctx) => {
      const ok = await ctx.approve('lock', 'Lock the computer?', 'Returns to the Windows lock screen.');
      return ok ? systemControl.lockComputer() : { error: 'The operator declined.' };
    },
  },
  {
    name: 'take_screenshot',
    owner: 'hephaestus',
    description: 'Save a screenshot of the screen to the Pictures folder.',
    parameters: obj({ filename: S('Optional file name') }),
    label: () => 'screenshot',
    run: async (args) => takeScreenshotAndSave(str(args, 'filename') || undefined),
  },
  {
    name: 'look_at_screen',
    owner: 'hephaestus',
    description: 'Look at what is on the operator\'s screen right now and answer a question about it. Only use when the operator asks you to look at their screen. Asks for approval (the image is sent to the brain).',
    parameters: obj({ question: S('What to look for or answer') }, ['question']),
    label: (a) => `look at screen: ${str(a, 'question').slice(0, 50)}`,
    run: async (args, ctx) => {
      const ok = await ctx.approve('screen', 'Let Ultron look at your screen?', 'A screenshot of your main display is sent to the active brain to answer:\n' + str(args, 'question'));
      if (!ok) return { error: 'The operator declined.' };
      const cap = await captureScreen();
      if (!cap.ok || !cap.dataUrl) return { error: cap.error ?? 'Screen capture failed.' };
      const [meta, data] = cap.dataUrl.split(',');
      const mimeType = /data:([^;]+)/.exec(meta)?.[1] ?? 'image/png';
      const res = await chat({
        system: 'You describe a screenshot of the operator\'s screen precisely and answer their question about it. Mention visible text exactly when relevant.',
        messages: [{ role: 'user', content: str(args, 'question') || 'What is on the screen?', images: [{ mimeType, data }] }],
        temperature: 0.2,
        signal: ctx.signal,
      });
      return { answer: res.text, seen_by: res.provider };
    },
  },
  {
    name: 'list_windows',
    owner: 'hephaestus',
    description: 'List the app windows currently open on the PC.',
    parameters: obj({}),
    label: () => 'list windows',
    run: async () => windowSwitch.listOpenWindows(),
  },
  {
    name: 'switch_window',
    owner: 'hephaestus',
    description: 'Bring an open window to the front by part of its title.',
    parameters: obj({ title_contains: S('Part of the window title') }, ['title_contains']),
    label: (a) => `focus "${str(a, 'title_contains')}"`,
    run: async (args) => windowSwitch.switchToWindow(str(args, 'title_contains')),
  },
  {
    name: 'system_info',
    owner: 'hephaestus',
    description: 'CPU/RAM load, battery and network (IP) status of the PC.',
    parameters: obj({}),
    label: () => 'system info',
    run: async () => {
      const [battery, ip] = await Promise.all([getBatteryInfo(), getIpInfo()]);
      return { hardware: getHardwareStats(), battery: battery.info ?? battery.error, network: ip.info ?? ip.error };
    },
  },
  {
    name: 'calculate',
    owner: 'athena',
    description: 'Exact maths in one expression (mathjs), or an equation to solve ("3(x - 4) = 2x + 7", "x^2 - 5x + 6 = 0", "4t - 9 = 3t + 1 for t" - solved exactly by the Compute Engine): + - * / ^, sqrt, sin, log, factorial, "15% of 240", fractions ("fraction(1,3) + fraction(1,6)"), unit conversions ("5 km to miles", "72 degF to degC", "3 hours to minutes"). Use it instead of doing maths in your head; for anything longer use run_code.',
    parameters: obj({ expression: S('e.g. "(12.5 * 4) / 3" or "180 cm to feet"') }, ['expression']),
    label: (a) => `calc ${str(a, 'expression')}`,
    run: async (args) => {
      const expression = str(args, 'expression');
      if (!workflow().newTools) return evaluate(expression);
      const r = await evaluateMath(expression);
      if (r.ok && r.result !== undefined) return { ok: true, result: r.result };
      // The small built-in parser still answers plain arithmetic if the sandbox is unavailable.
      const plain = evaluate(expression);
      return plain.ok ? plain : { ok: false, error: r.error ?? plain.error };
    },
  },
  {
    name: 'run_code',
    owner: 'athena',
    description: 'Run JavaScript (not Python) in a locked sandbox (no files, no internet, 8-second limit) to get EXACT answers: sums and percentages over lists, algebra and equations, statistics, dates and time differences, unit conversions, sorting, counting and filtering data you already have, checking a puzzle or a schedule by trying every case. console.log() what you need; the last expression is returned too. The mathjs library is ready as `math`: math.fraction(1,3), math.evaluate("5 km to miles"), math.simplify("2x + 3x"), math.derivative("x^2", "x"), math.lusolve([[2,1],[1,3]], [3,5]), math.mean([...]), math.std([...]). The Compute Engine is ready as `CE` for algebra: CE.solve("3(x-4)=2x+7", "x"), CE.factor("x^2-5x+6"), CE.expand("(x+1)^2"), CE.simplify("x+x+1"); ce.parse(latex) reads LaTeX. Clock times: clock("8:20 pm") is the exact hour (20.333...), minutesBetween("6:45 pm", "8:20 pm") is 95, timeOfDay(16.025) is "4:02 pm". Never do multi-step maths in your head - run it here.',
    parameters: obj({ code: S('Synchronous JavaScript, e.g. const s = [78, 91]; console.log(s.reduce((a, b) => a + b) / s.length). End with the value you want, or console.log it.') }, ['code']),
    label: (a) => `run code (${str(a, 'code').split('\n').length} line${str(a, 'code').split('\n').length === 1 ? '' : 's'})`,
    run: async (args) => {
      const r = await runCode(str(args, 'code'));
      return {
        ok: r.ok,
        output: r.output.length ? r.output.join('\n') : undefined,
        result: r.result,
        error: r.error,
        ms: r.ms,
      };
    },
  },
  {
    name: 'ask_wolfram',
    owner: 'hephaestus',
    description: 'Ask WolframAlpha a computational or scientific question (unit conversions, formulas, facts). Needs a WolframAlpha key in Settings.',
    parameters: obj({ query: S('Question') }, ['query']),
    label: (a) => `wolfram "${str(a, 'query').slice(0, 50)}"`,
    run: async (args) => (wolfram.hasKey() ? wolfram.askWolframAlpha(str(args, 'query')) : { error: 'No WolframAlpha key configured.' }),
  },
  {
    name: 'distance_between',
    owner: 'hephaestus',
    description: 'Straight-line distance in km between two places.',
    parameters: obj({ from: S('Place'), to: S('Place') }, ['from', 'to']),
    label: (a) => `distance ${str(a, 'from')} -> ${str(a, 'to')}`,
    run: async (args) => distanceToPlace(str(args, 'from'), str(args, 'to')),
  },
];
