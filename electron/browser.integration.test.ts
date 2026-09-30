import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

/*
 * Drives the REAL agent browser (Playwright Chromium, persistent profile)
 * against a tiny local site - no model involved. Proves the hands work:
 * forms, rich editors, shortcuts, canvas drawing, dropdowns, waiting,
 * marked screenshots, what the safety checks see, and that website logins
 * survive the browser closing and reopening.
 */

const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'ultron-browser-it-'));
const docs: Record<string, unknown> = {};

vi.mock('electron', () => ({ app: { getPath: () => userData, getLocale: () => 'en-US', isPackaged: false, getAppPath: () => process.cwd() }, BrowserWindow: class {} }));
vi.mock('./store', () => ({
  getSettings: () => ({ browser: { visible: false } }),
  readDoc: (name: string, fallback: unknown) => docs[name] ?? fallback,
  writeDoc: (name: string, value: unknown) => { docs[name] = value; },
}));
vi.mock('./brain/events', () => ({ emit: () => {} }));

const browser = await import('./browser');

const PAGE = `<!doctype html><html><head><title>Workbench</title></head><body>
<form id="f" onsubmit="event.preventDefault(); document.getElementById('out').textContent = 'searched:' + document.getElementById('q').value">
  <input id="q" type="search" aria-label="Search" placeholder="Search">
  <input id="pw" type="password" aria-label="Password">
  <select id="size" aria-label="Size"><option>Small</option><option>Large</option></select>
  <button type="submit">Go</button>
</form>
<div id="editor" contenteditable="true" role="textbox" aria-label="Document body" style="min-height:40px;border:1px solid #999"></div>
<button id="post" onclick="document.getElementById('out').textContent='posted'">Post</button>
<canvas id="c" width="300" height="200" style="position:absolute;left:600px;top:40px;border:1px solid #000"></canvas>
<p id="drawn"></p>
<p id="out"></p>
<script>
  const c = document.getElementById('c'), g = c.getContext('2d'); let down = false; window.strokes = 0;
  c.addEventListener('mousedown', () => { down = true; window.strokes++; });
  c.addEventListener('mousemove', (e) => { if (down) { g.fillRect(e.offsetX, e.offsetY, 3, 3); } });
  addEventListener('mouseup', () => { if (down) document.getElementById('drawn').textContent = 'drew ' + window.strokes; down = false; });
  setTimeout(() => { const s = document.createElement('span'); s.textContent = 'All changes saved'; document.body.appendChild(s); }, 700);
</script></body></html>`;

// A code-playground-style page: an editor, and a live preview in a frame from ANOTHER origin (like CodePen's).
const PEN = (port: number) => `<!doctype html><html><head><title>Pen</title></head><body style="margin:0">
<textarea aria-label="HTML code" style="position:absolute;left:0;top:0;width:500px;height:150px"></textarea>
<div class="panel" style="position:absolute;left:650px;top:0;width:400px"><div class="title">HTML</div><div class="monaco-editor"><div class="native-edit-context" role="textbox" aria-label="Editor content" contenteditable="true" style="height:40px;border:1px solid #999"></div><textarea class="ime-text-area" readonly style="width:300px;height:30px"></textarea></div></div>
<iframe title="preview" src="http://localhost:${port}/preview" style="position:absolute;left:0;top:200px;width:600px;height:300px;border:0"></iframe>
</body></html>`;

const PREVIEW = `<!doctype html><html><body style="margin:0">
<h1 id="h" style="position:absolute;left:20px;top:100px;margin:0">Preview ready</h1>
<button style="position:absolute;left:20px;top:20px;width:120px;height:40px" onclick="document.getElementById('h').textContent='Clicked inside frame'">Say hi</button>
<input aria-label="Frame input" style="position:absolute;left:200px;top:20px" oninput="document.getElementById('h').textContent='typed:'+this.value">
</body></html>`;

let server: http.Server;
let base = '';
let port = 0;
const owner = { id: 'it:daedalus', runId: 'it', agent: 'daedalus', label: 'DAEDALUS' };

beforeAll(async () => {
  server = http.createServer((req, res) => {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    if (req.url === '/') {
      // A login-style session cookie: no expiry - exactly what Chromium drops when it closes.
      res.setHeader('Set-Cookie', 'sid=abc123; Path=/; HttpOnly');
      res.end(PAGE);
    } else if (req.url === '/wall' || req.url === '/brief-check') {
      // A site's bot check: 403 + "Just a moment...". The brief one clears itself like a passing check does.
      res.statusCode = 403;
      const clears = req.url === '/brief-check' ? '<script>setTimeout(() => location.replace("/after-check"), 800)</script>' : '';
      res.end(`<!doctype html><title>Just a moment...</title><p>Performing security verification</p>${clears}`);
    } else if (req.url === '/humanity') {
      res.end('<!doctype html><title>Reddit - Prove your humanity</title><p>Complete the challenge below.</p><input aria-label="Answer"><button>Verify</button>');
    } else if (req.url === '/after-check') {
      res.end('<!doctype html><title>Real page</title><p>Welcome in</p>');
    } else if (req.url === '/pen') {
      res.end(PEN(port));
    } else if (req.url === '/preview') {
      res.end(PREVIEW);
    } else {
      res.end('<p>cookie:' + (req.headers.cookie ?? 'none') + '</p>');
    }
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  port = (server.address() as { port: number }).port;
  base = `http://127.0.0.1:${port}`;
}, 30_000);

// Closing Chromium (it saves website logins first) and deleting its profile can take over 10 s on a busy PC.
afterAll(async () => {
  await browser.closeBrowser();
  server.close();
  fs.rmSync(userData, { recursive: true, force: true, maxRetries: 3 });
}, 60_000);

const refFor = (elements: string[] | undefined, needle: string) => {
  const line = (elements ?? []).find((l) => l.includes(needle));
  return line ? Number(/^\[(\d+)\]/.exec(line)?.[1]) : -1;
};

describe('agent browser (real Chromium)', () => {
  it('opens a page and sees its elements', async () => {
    const snap = await browser.open(owner, base + '/');
    expect(snap.ok).toBe(true);
    expect(refFor(snap.elements, '"Search"')).toBeGreaterThan(0);
  }, 60_000);

  it('fills a form field, submits with Enter, and picks from a dropdown', async () => {
    const snap = await browser.snapshot(owner);
    const search = refFor(snap.elements, '"Search"');
    await browser.type(owner, search, 'mongol empire', true);
    const size = refFor((await browser.snapshot(owner)).elements, 'select');
    await browser.select(owner, size, 'Large');
    const r = await browser.read(owner, 'page', 4000);
    expect(r.text).toContain('searched:mongol empire');
  }, 60_000);

  it('types into a rich editor by focus and applies keyboard shortcuts', async () => {
    const snap = await browser.snapshot(owner);
    const editor = refFor(snap.elements, 'Document body');
    await browser.type(owner, editor, 'Line one', false);
    await browser.press(owner, 'Enter');
    await browser.type(owner, null, 'The Mongol Empire\n  was the largest contiguous land empire.', false);
    const r = await browser.read(owner, 'page', 4000);
    expect(r.text).toContain('Line one');
    expect(r.text).toContain('largest contiguous land empire');
    expect((await browser.press(owner, 'Control+A Nope')).ok).toBe(false);
  }, 60_000);

  it('draws on a canvas with a mouse drag', async () => {
    const tab = await browser.snapshot(owner);
    expect(tab.ok).toBe(true);
    // Canvas sits below the form; find it on screen via the marked screenshot's element list, then drag across it.
    const drag = await browser.mouse(owner, 'drag', 650, 90, 820, 180);
    expect(drag.ok).toBe(true);
    expect((await browser.read(owner, 'page', 4000)).text).toContain('drew 1');
  }, 60_000);

  it('waits for text to appear', async () => {
    const w = await browser.waitFor(owner, 'All changes saved', 5);
    expect(w.ok).toBe(true);
    expect((await browser.waitFor(owner, 'never going to appear', 1)).ok).toBe(false);
  }, 60_000);

  it('describes targets for the safety checks', async () => {
    const snap = await browser.snapshot(owner);
    const post = await browser.describeRef(owner, refFor(snap.elements, '"Post"'));
    expect(post?.text).toBe('Post');
    const pw = await browser.describeRef(owner, refFor(snap.elements, '"Password"'));
    expect(pw?.sensitive).toBe(true);
  }, 60_000);

  it('takes a marked screenshot with numbered elements', async () => {
    const shot = await browser.screenshot(owner, true);
    expect(shot.ok).toBe(true);
    expect((shot.data ?? '').length).toBeGreaterThan(5000);
    expect(shot.elements?.length).toBeGreaterThan(3);
  }, 60_000);

  it('sees, reads and works inside an embedded frame from another site', async () => {
    const snap = await browser.open(owner, base + '/pen');
    expect(snap.ok).toBe(true);
    expect(snap.visible_text).toContain('Preview ready');
    const button = refFor(snap.elements, '"Say hi"');
    expect(button).toBeGreaterThan(0);
    expect(snap.elements?.find((l) => l.includes('"Say hi"'))).toContain('inside embedded localhost');
    // The safety checks see what is inside the frame - by number and by screen position.
    expect((await browser.describeRef(owner, button))?.text).toBe('Say hi');
    expect((await browser.describePoint(owner, 60, 240))?.text).toBe('Say hi');
    await browser.click(owner, button);
    expect((await browser.read(owner, 'article', 4000)).text).toContain('Clicked inside frame');
    const input = refFor((await browser.snapshot(owner)).elements, '"Frame input"');
    await browser.type(owner, input, 'hello', false);
    expect((await browser.waitFor(owner, 'typed:hello', 3)).ok).toBe(true);
    expect((await browser.find(owner, 'typed:hello')).hits?.[0]).toContain('[in embedded localhost]');
    expect((await browser.describeFocused(owner))?.label).toBe('Frame input');
    const shot = await browser.screenshot(owner, true);
    expect(shot.elements?.some((l) => l.includes('"Say hi"'))).toBe(true);
  }, 60_000);

  it('names code editors after their panel and hides their read-only helper boxes', async () => {
    const snap = await browser.open(owner, base + '/pen');
    const editor = refFor(snap.elements, 'code editor "HTML editor"');
    expect(editor).toBeGreaterThan(0);
    expect(snap.elements?.some((l) => l.includes('textarea ""'))).toBe(false);
    await browser.type(owner, editor, '<h1>ULTRON</h1>', false);
    expect((await browser.read(owner, 'page', 4000)).text).toContain('<h1>ULTRON</h1>');
    expect(await browser.pageState(owner)).toContain('[EMBEDDED FRAME localhost]');
  }, 60_000);

  it('waits out a bot check that clears itself, and reports one that does not', async () => {
    const passed = await browser.open(owner, base + '/brief-check');
    expect(passed.ok).toBe(true);
    expect(passed.title).toBe('Real page');
    const wall = await browser.open(owner, base + '/wall');
    expect(wall.ok).toBe(false);
    expect(wall.error).toContain('checking for bots');
  }, 60_000);

  it('never types, clicks or answers on a CAPTCHA or block page', async () => {
    const snap = await browser.open(owner, base + '/humanity');
    expect(snap.ok).toBe(true);
    expect(snap.warning).toMatch(/bot check/);
    const typed = await browser.type(owner, refFor(snap.elements, '"Answer"'), 'I am human', false);
    expect(typed.ok).toBe(false);
    expect(typed.error).toMatch(/never claim to be human/);
    expect((await browser.click(owner, refFor(snap.elements, '"Verify"'))).error).toMatch(/bot check or a block page/);
    expect((await browser.press(owner, 'Enter')).ok).toBe(false);
    expect((await browser.mouse(owner, 'click', 50, 50)).ok).toBe(false);
  }, 60_000);

  it('keeps website logins when the browser closes and reopens', async () => {
    await browser.keepAgentLogins();
    await browser.closeBrowser();
    const again = await browser.open(owner, base + '/other');
    expect(again.ok).toBe(true);
    // The reopened browser sent the session cookie from before the restart.
    const read = await browser.read(owner, 'page', 500);
    expect(read.text).toContain('cookie:sid=abc123');
  }, 90_000);
});
