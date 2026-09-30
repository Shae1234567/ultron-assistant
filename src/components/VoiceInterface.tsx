import { useEffect, useRef, useState } from 'react';
import { HexPanel } from './hud/HexPanel';
import { Waveform } from './hud/Waveform';
import { BarSpectrum } from './hud/BarSpectrum';
import { useStore, useSttStore } from '../state/store';
import { beginPushToTalk, endPushToTalk, cancelCurrent, preloadSpeechModel } from '../services/conversation';
import { ttsSupported, primeVoices, pickVoice } from '../services/speech';
import {
  startLiveVoiceSession, stopLiveVoiceSession, onLiveVoiceState, getLiveVoiceState, type LiveVoiceState,
} from '../services/liveVoiceSession';
import { isLiveVoiceSupported } from '../services/liveVoice';
import { playClick, playConfirm, playAlert } from '../services/sfx';

const isTypingTarget = (el: EventTarget | null): boolean => {
  const node = el as HTMLElement | null;
  if (!node) return false;
  const tag = node.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || node.isContentEditable;
};

export function VoiceInterface() {
  const coreState = useStore((s) => s.coreState);
  const [voiceName, setVoiceName] = useState<string | null>(null);
  const held = useRef(false);
  const [liveState, setLiveState] = useState<LiveVoiceState>(getLiveVoiceState());
  const [liveError, setLiveError] = useState<string | null>(null);
  const pushEntry = useStore((s) => s.pushEntry);

  useEffect(() => onLiveVoiceState(setLiveState), []);
  useEffect(() => () => stopLiveVoiceSession(), []); // never leave a mic stream open behind a closed HUD

  const toggleLiveVoice = async () => {
    playClick();
    if (liveState === 'live' || liveState === 'connecting') {
      stopLiveVoiceSession();
      return;
    }
    setLiveError(null);
    const res = await startLiveVoiceSession({
      onTranscript: (text) => pushEntry({ who: 'ultron', text }),
      onError: (message) => setLiveError(message),
    });
    if (res.ok) playConfirm();
    else { playAlert(); setLiveError(res.error ?? 'Could not start Live Voice.'); }
  };

  useEffect(() => {
    primeVoices();
    const id = setTimeout(() => setVoiceName(pickVoice()?.name ?? null), 800);
    return () => clearTimeout(id);
  }, []);

  // Push-to-talk: hold SPACE anywhere that is not a text field.
  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      if (e.code !== 'Space' || e.repeat || isTypingTarget(e.target)) return;
      e.preventDefault();
      if (held.current) return;
      held.current = true;
      playClick();
      void beginPushToTalk();
    };
    const up = (e: KeyboardEvent) => {
      if (e.code !== 'Space' || isTypingTarget(e.target)) return;
      e.preventDefault();
      if (!held.current) return;
      held.current = false;
      endPushToTalk();
    };
    const esc = (e: KeyboardEvent) => {
      if (e.key === 'Escape') cancelCurrent();
    };
    // If the window loses focus while Space is physically held (alt-tab, an
    // OS dialog, minimize), no keyup ever arrives on this window - held.current
    // would stay true forever and silently swallow every Space press after.
    const release = () => {
      if (!held.current) return;
      held.current = false;
      endPushToTalk();
    };
    const onVisibility = () => { if (document.hidden) release(); };
    window.addEventListener('keydown', down);
    window.addEventListener('keyup', up);
    window.addEventListener('keydown', esc);
    window.addEventListener('blur', release);
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      window.removeEventListener('keydown', down);
      window.removeEventListener('keyup', up);
      window.removeEventListener('keydown', esc);
      window.removeEventListener('blur', release);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, []);
  const stt = useSttStore((s) => s.stt);
  const busy = useStore((s) => s.busy);
  const sttReason = useSttStore((s) => s.sttReason);
  const sttProgress = useSttStore((s) => s.sttProgress);

  const sttChip =
    stt === 'ok' ? { label: 'WHISPER READY', cls: 'chip--good' }
    : stt === 'transcribing' ? { label: 'TRANSCRIBING', cls: '' }
    : stt === 'loading' ? { label: `LOADING ${Math.round(sttProgress * 100)}%`, cls: '' }
    : stt === 'unavailable' ? { label: 'STT UNAVAILABLE', cls: 'chip--bad' }
    : { label: 'VOICE MODEL IDLE', cls: 'chip--muted' };

  const canTalk = stt !== 'unavailable' && stt !== 'loading';
  const ttsOk = ttsSupported();

  return (
    <HexPanel
      title="Voice Interface"
      meta={coreState.toUpperCase()}
      scroll={false}
      style={{ flex: '0 0 auto' }}
    >
      <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0,1fr) 190px', gap: 12, padding: '10px 14px' }}>
        <div>
          <Waveform height={56} live amplitude={coreState === 'idle' ? 1 : 1.5} />
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 6, flexWrap: 'wrap' }}>
            <button
              className={`hud-btn ${coreState === 'listening' ? 'hud-btn--active' : ''}`}
              onMouseDown={() => { held.current = true; void beginPushToTalk(); }}
              onMouseUp={() => { held.current = false; endPushToTalk(); }}
              onMouseLeave={() => { if (held.current) { held.current = false; endPushToTalk(); } }}
              disabled={!canTalk}
              title={canTalk ? 'Hold to talk' : (sttReason || 'Speech to text unavailable')}
              aria-label="Hold to talk to Ultron"
              aria-pressed={coreState === 'listening'}
            >
              {coreState === 'listening' ? 'Listening' : 'Hold to talk'}
            </button>
            <span className="mono" style={{ fontSize: 10, color: 'var(--dim)', letterSpacing: '0.1em' }}>
              HOLD [SPACE] TO SPEAK / [ESC] TO STOP
            </span>
            {stt === 'unknown' && (
              <button className="hud-btn" onClick={preloadSpeechModel} title="Downloads the Whisper model once, then runs offline">
                Load voice model
              </button>
            )}
            {(busy || coreState === 'listening' || coreState === 'speaking') && (
              <button className="hud-btn hud-btn--danger" onClick={cancelCurrent}>Abort</button>
            )}
            {isLiveVoiceSupported() && (
              <button
                className={`hud-btn ${liveState === 'live' ? 'hud-btn--active' : ''}`}
                onClick={() => void toggleLiveVoice()}
                disabled={liveState === 'connecting'}
                title="Real-time spoken conversation via Gemini Live - needs a Gemini API key in Settings"
                aria-label="Toggle Live Voice"
                aria-pressed={liveState === 'live'}
              >
                {liveState === 'live' ? 'Live Voice: ON' : liveState === 'connecting' ? 'Connecting...' : 'Live Voice'}
              </button>
            )}
          </div>
          {liveError && (
            <div className="mono" style={{ fontSize: 10, color: 'var(--red)', marginTop: 5 }}>{liveError}</div>
          )}
          {stt === 'loading' && (
            <div style={{ marginTop: 7 }}>
              <div style={{ height: 3, background: 'var(--cyan-12)', overflow: 'hidden' }}>
                <div style={{
                  height: '100%', width: `${Math.round(sttProgress * 100)}%`,
                  background: 'var(--cyan)', boxShadow: 'var(--glow-sm)',
                  transition: 'width 0.25s linear',
                }} />
              </div>
              <div className="mono" style={{ fontSize: 9.5, color: 'var(--dim)', marginTop: 3 }}>
                {sttReason || 'Loading Whisper...'}
              </div>
            </div>
          )}
        </div>

        <div>
          <BarSpectrum bars={26} height={56} live />
          <div style={{ display: 'flex', flexDirection: 'column', gap: 2, marginTop: 6 }}>
            <span className={`chip ${sttChip.cls}`} style={{ justifyContent: 'center' }} title={sttReason}>
              {sttChip.label}
            </span>
            <span className={`chip ${ttsOk ? 'chip--good' : 'chip--muted'}`} style={{ justifyContent: 'center' }}>
              TTS {ttsOk ? (voiceName ? voiceName.slice(0, 18) : 'READY') : 'N/A'}
            </span>
          </div>
        </div>
      </div>
    </HexPanel>
  );
}
