import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { shell } from 'electron';

/**
 * Spotify on this PC, without Spotify's Web API. Spotify only lets Premium accounts own a developer app or
 * control playback through the API - so Composio's Spotify can't work with Spotify Free. Instead Ultron drives
 * the Spotify desktop app itself:
 *  - play / pause / next / previous / what's playing: through Windows' own media controls (the same ones the
 *    media keys and the volume flyout use), aimed at Spotify's session - so a YouTube tab playing in the browser
 *    is left alone;
 *  - finding music: the spotify: link Windows hands to the app (a search, or an artist, album, playlist or track
 *    page). The app opens it; starting that exact song is the one thing only the paid API can do.
 */

export type SpotifyAction = 'status' | 'play' | 'pause' | 'toggle' | 'next' | 'previous';
export const ACTIONS: SpotifyAction[] = ['status', 'play', 'pause', 'toggle', 'next', 'previous'];

export interface SpotifyState {
  /** Spotify has a media session in Windows - it is open and has something loaded. */
  session: boolean;
  ok?: boolean;
  title?: string;
  artist?: string;
  album?: string;
  /** Windows' word for it: Playing, Paused, Stopped... */
  status?: string;
}

/** The desktop app's usual places (the installer's, and the Microsoft Store's alias). */
export function installed(): boolean {
  const places = [
    process.env.APPDATA && path.join(process.env.APPDATA, 'Spotify', 'Spotify.exe'),
    process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Microsoft', 'WindowsApps', 'Spotify.exe'),
  ].filter((p): p is string => Boolean(p));
  return places.some((p) => fs.existsSync(p));
}

/** The PowerShell that talks to Windows' media controls. `action` is one of ACTIONS - never text from outside. */
export function mediaScript(action: SpotifyAction): string {
  if (!ACTIONS.includes(action)) throw new Error(`unknown action ${action}`);
  const call: Record<SpotifyAction, string> = {
    status: '',
    play: '$ok = Await ($s.TryPlayAsync()) ([bool])',
    pause: '$ok = Await ($s.TryPauseAsync()) ([bool])',
    toggle: '$ok = Await ($s.TryTogglePlayPauseAsync()) ([bool])',
    next: '$ok = Await ($s.TrySkipNextAsync()) ([bool])',
    previous: '$ok = Await ($s.TrySkipPreviousAsync()) ([bool])',
  };
  return [
    "$ErrorActionPreference = 'Stop'",
    'Add-Type -AssemblyName System.Runtime.WindowsRuntime',
    "$asTask = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object { $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1' })[0]",
    "function Await($op, [Type]$type) { $t = $asTask.MakeGenericMethod($type).Invoke($null, @($op)); if (-not $t.Wait(5000)) { throw 'Windows media controls did not answer' }; $t.Result }",
    '$null = [Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager, Windows.Media.Control, ContentType = WindowsRuntime]',
    '$mgr = Await ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager]::RequestAsync()) ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager])',
    "$s = @($mgr.GetSessions()) | Where-Object { $_.SourceAppUserModelId -match 'spotify' } | Select-Object -First 1",
    "if (-not $s) { '{\"session\":false}'; exit 0 }",
    '$ok = $true',
    call[action],
    action === 'status' ? '' : 'Start-Sleep -Milliseconds 800',
    '$p = Await ($s.TryGetMediaPropertiesAsync()) ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionMediaProperties])',
    '[pscustomobject]@{ session = $true; ok = [bool]$ok; title = $p.Title; artist = $p.Artist; album = $p.AlbumTitle; status = [string]$s.GetPlaybackInfo().PlaybackStatus } | ConvertTo-Json -Compress',
  ].filter(Boolean).join('\n');
}

function runPowerShell(script: string, timeoutMs = 15_000): Promise<string> {
  // -EncodedCommand: the script goes over as base64 UTF-16, so no quoting can break it.
  const encoded = Buffer.from(script, 'utf16le').toString('base64');
  return new Promise((resolve, reject) => {
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded], { timeout: timeoutMs, windowsHide: true }, (err, stdout, stderr) => {
      if (err) reject(new Error((stderr || err.message).trim().split(/\r?\n/)[0] || 'PowerShell failed'));
      else resolve(stdout);
    });
  });
}

/** The last JSON line PowerShell printed. */
export function parseState(stdout: string): SpotifyState {
  const line = stdout.trim().split(/\r?\n/).reverse().find((l) => l.trim().startsWith('{'));
  if (!line) throw new Error('No answer from Windows media controls.');
  const j = JSON.parse(line) as SpotifyState;
  return { session: Boolean(j.session), ok: j.ok, title: j.title || undefined, artist: j.artist || undefined, album: j.album || undefined, status: j.status || undefined };
}

export async function mediaState(action: SpotifyAction = 'status'): Promise<SpotifyState> {
  return parseState(await runPowerShell(mediaScript(action)));
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Play, pause, skip or ask what's on. If Spotify isn't open, playing opens it first and waits for it
 * (up to ~12 s) - Spotify resumes whatever it last had loaded.
 */
export async function control(action: SpotifyAction): Promise<SpotifyState & { opened?: boolean }> {
  let state = await mediaState(action);
  if (state.session || action === 'status' || action === 'pause') return state;
  if (!installed()) throw new Error('The Spotify app is not installed on this PC.');
  await shell.openExternal('spotify:');
  for (let i = 0; i < 12; i++) {
    await sleep(1000);
    state = await mediaState('status').catch(() => ({ session: false }));
    if (state.session) return { ...(await mediaState(action)), opened: true };
  }
  return { session: false, opened: true };
}

/**
 * A spotify: link for what the operator wants: an open.spotify.com link or spotify: URI as it is, otherwise a
 * search. Only these two shapes are ever opened.
 */
export function spotifyUri(query: string): string {
  const q = query.trim();
  const web = /^https?:\/\/open\.spotify\.com\/(?:intl-[a-z-]+\/)?(track|album|artist|playlist|show|episode)\/([A-Za-z0-9]{10,40})/i.exec(q);
  if (web) return `spotify:${web[1].toLowerCase()}:${web[2]}`;
  if (/^spotify:(track|album|artist|playlist|show|episode):[A-Za-z0-9]{10,40}$/i.test(q)) return q;
  return `spotify:search:${encodeURIComponent(q.replace(/^spotify:search:/i, ''))}`;
}

export async function openInSpotify(query: string): Promise<{ opened: string }> {
  if (!installed()) throw new Error('The Spotify app is not installed on this PC.');
  const uri = spotifyUri(query);
  await shell.openExternal(uri);
  return { opened: uri };
}
