import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { HexPanel } from './hud/HexPanel';
import { useStore } from '../state/store';
import { submitMessage, cancelCurrent } from '../services/conversation';
import { ultron } from '../services/bridge';
import type { TranscriptEntry } from '../types';

const WHO_LABEL: Record<string, string> = { you: 'OPERATOR', ultron: 'ULTRON', system: 'SYSTEM' };

function TeamTrace({ entry }: { entry: TranscriptEntry }) {
  const info = useStore((s) => s.agentsInfo);
  const [open, setOpen] = useState(false);
  const team = entry.team;
  if (!team) return null;
  const color = (id: string) => info.find((a) => a.id === id)?.color ?? 'var(--cyan)';
  const name = (id: string) => (info.find((a) => a.id === id)?.name ?? id).toUpperCase();
  return (
    <>
      <div className="msg__team">
        <span className="msg__team-label">TEAM</span>
        {team.agents.map((a) => <span key={a} className="agent-tag" style={{ color: color(a) }}>{name(a)}</span>)}
        {team.actions.length > 0 && (
          <span className="link-btn" style={{ fontSize: 10 }} onClick={() => setOpen((v) => !v)}>
            {open ? 'hide' : `${team.actions.length} actions`}
          </span>
        )}
        {team.runNote && (
          <span className="link-btn" style={{ fontSize: 10 }} onClick={() => void ultron.vault.open(team.runNote)}>team log</span>
        )}
      </div>
      {open && (
        <div className="msg__trace">
          {team.actions.map((l) => (
            <div key={l.id} className={`activity__line ${l.kind ? `activity__line--${l.kind}` : ''}`} style={{ '--agent': color(l.agent) } as CSSProperties}>
              <span className="activity__agent">{name(l.agent)}</span>
              <span className="activity__text">{l.text}</span>
            </div>
          ))}
        </div>
      )}
    </>
  );
}

export function TranscriptPanel() {
  const transcript = useStore((s) => s.transcript);
  const clearTranscript = useStore((s) => s.clearTranscript);
  const coreState = useStore((s) => s.coreState);
  const busy = useStore((s) => s.busy);
  const [draft, setDraft] = useState('');
  const bodyRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = bodyRef.current;
    if (!el) return;
    // Only follow the bottom if the operator was already there - streaming
    // shouldn't yank them back down while they reread something.
    const wasNearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 60;
    if (wasNearBottom) el.scrollTop = el.scrollHeight;
  }, [transcript]);

  const send = () => {
    const text = draft.trim();
    if (!text || busy) return;
    setDraft('');
    void submitMessage(text);
  };

  return (
    <HexPanel
      title="Transcript"
      meta={`${transcript.length} ENTR${transcript.length === 1 ? 'Y' : 'IES'}`}
      scroll={false}
      actions={
        <div style={{ display: 'flex', gap: 6, marginLeft: 8 }}>
          {coreState !== 'idle' && <button className="hud-btn hud-btn--danger" onClick={cancelCurrent}>Stop</button>}
          <button className="hud-btn" onClick={clearTranscript} disabled={!transcript.length || busy}>Clear</button>
        </div>
      }
    >
      <div className="panel-body" ref={bodyRef} style={{ flex: '1 1 auto' }}>
        {transcript.length === 0 ? (
          <div className="empty-note">
            No exchanges yet. Hold <strong style={{ color: 'var(--cyan)' }}>SPACE</strong> to speak, or type below.
          </div>
        ) : (
          <div className="transcript">
            {transcript.map((m) => (
              <div key={m.id} className={`msg msg--${m.who} ${m.error ? 'msg--error' : ''}`}>
                <div className="msg__who">{WHO_LABEL[m.who] ?? m.who}</div>
                <div className="msg__text">
                  {m.text}
                  {m.streaming && <span className="caret" />}
                </div>
                {m.sources && m.sources.length > 0 && (
                  <div className="msg__sources">
                    <span className="msg__sources-label">SOURCES</span>
                    <div className="tag-row">
                      {m.sources.map((s) => {
                        let host = s.url;
                        try { host = new URL(s.url).hostname.replace(/^www\./, ''); } catch { /* keep raw */ }
                        return (
                          <span key={s.url} className="chip" title={s.title} onClick={() => void ultron.app.openExternal(s.url)}>{host}</span>
                        );
                      })}
                    </div>
                  </div>
                )}
                <TeamTrace entry={m} />
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="composer">
        <span className="composer__prompt">&gt;</span>
        <input
          className="hud-input"
          value={draft}
          placeholder={busy ? 'The team is working - Stop to interrupt' : 'Type a command for Ultron...'}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } }}
        />
        <button className="hud-btn" onClick={send} disabled={!draft.trim() || busy}>Send</button>
      </div>
    </HexPanel>
  );
}
