import { useEffect, useRef, useState } from 'react';
import { Backdrop } from './components/Backdrop';
import { TopBar } from './components/TopBar';
import { CoreOrb } from './components/CoreOrb';
import { VoiceInterface } from './components/VoiceInterface';
import { TranscriptPanel } from './components/TranscriptPanel';
import { NewsPanel } from './components/NewsPanel';
import { SystemPanel } from './components/SystemPanel';
import { SettingsPanel, BrainSetup, MemoryPanel, AppsPanel, FirstRunSetup, OverlaySuspense } from './components/LazyOverlays';
import { providerLabel } from './services/providers';
import { BootSequence } from './components/BootSequence';
import { CommandPalette } from './components/CommandPalette';
import { ApprovalPrompt } from './components/ApprovalPrompt';
import { IdleDashboard } from './components/hud/IdleDashboard';
import { ClipboardPanel } from './components/ClipboardPanel';
import { useStore, useSttStore, type RightTab, type Overlay } from './state/store';
import type { CoreState } from './types';
import { ultron } from './services/bridge';
import { decodeToMono16k } from './services/recorder';
import { ensureModel, transcribe } from './services/stt';
import { ttsSupported } from './services/speech';
import { restoreWakeWord } from './services/wakeWordControl';
import { handleReminder, initProactiveGreeting, scheduleProactiveCheckIn } from './services/proactive';
import { playAlert } from './services/sfx';

const CAPTION: Record<CoreState, { text: string; hint: string; color: string }> = {
  idle:      { text: 'STANDBY',   hint: 'HOLD [SPACE] TO SPEAK', color: 'var(--cyan)' },
  listening: { text: 'LISTENING', hint: 'RELEASE TO SEND',        color: '#7de9ff' },
  thinking:  { text: 'PROCESSING', hint: 'THINKING',              color: 'var(--cyan)' },
  speaking:  { text: 'RESPONDING', hint: '[ESC] TO INTERRUPT',    color: '#b9f2ff' },
  offline:   { text: 'BRAIN OFFLINE', hint: 'OPEN SETTINGS FOR SETUP', color: 'var(--red)' },
};

export function App() {
  const coreState = useStore((s) => s.coreState);
  const overlay = useStore((s) => s.overlay);
  const setOverlay = useStore((s) => s.setOverlay);
  const phaseLabel = useStore((s) => s.team.phaseLabel);
  const announced = useRef(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [clipboardText, setClipboardText] = useState<string | null>(null);

  // Clipboard Intelligence: only ever appears if the operator copies something.
  useEffect(() => ultron.clipboard.onNewText((text) => setClipboardText(text)), []);

  // Ctrl+K / Cmd+K opens the command palette from anywhere.
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setPaletteOpen((v) => !v);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  // Startup probes - each also feeds the boot screen with a real pass/warn.
  useEffect(() => {
    const s = useStore.getState();
    const cleanups: (() => void)[] = [];
    void ultron.settings.get()
      .then((settings) => {
        s.setSettings(settings);
        s.setFolders(settings.folders);
        s.setBootCheck('settings', 'ok');
        void ultron.research.weather(settings.profile.location).then(s.setWeather);
        void restoreWakeWord();
      })
      .catch(() => s.setBootCheck('settings', 'warn'));

    void ultron.vault.stats()
      .then((v) => s.setBootCheck('memory', v.root && !v.root.startsWith('(') ? 'ok' : 'warn'))
      .catch(() => s.setBootCheck('memory', 'warn'));

    s.setBootCheck('voice', ttsSupported() ? 'ok' : 'warn');
    void ultron.brain.agents().then(s.setAgentsInfo);
    void ultron.tasks.list().then(s.setTasks);

    // The conversation picks up where it left off; saving starts only once it's back, so a fast boot
    // can't overwrite it with an empty chat.
    let saveTimer: ReturnType<typeof setTimeout> | null = null;
    let lastSeen = s.transcript;
    let unsubscribeSave: (() => void) | null = null;
    void ultron.transcript.load()
      .then((entries) => { if (entries.length) useStore.getState().restoreTranscript(entries); })
      .catch(() => {})
      .finally(() => {
        unsubscribeSave = useStore.subscribe((st) => {
          if (st.transcript === lastSeen) return;
          lastSeen = st.transcript;
          if (st.transcript.some((t) => t.streaming)) return;
          if (saveTimer) clearTimeout(saveTimer);
          saveTimer = setTimeout(() => void ultron.transcript.save(useStore.getState().transcript), 1500);
        });
      });
    cleanups.push(() => { unsubscribeSave?.(); if (saveTimer) clearTimeout(saveTimer); });
    void ultron.approvals.pending().then((list) => list.forEach(s.addApproval));
    void ultron.apps.status().then(s.setApps);
    void ultron.d2l.status().then(s.setD2L);

    void ultron.brain.status().then((status) => {
      s.setBrain(status);
      s.setBootCheck('brain', status.active ? 'ok' : 'warn');
      if (announced.current) return;
      announced.current = true;
      // A new install starts with the setup: name, AI provider, apps.
      void ultron.settings.get().then((cfg) => { if (!cfg.setupDone) setOverlay({ kind: 'setup' }); }).catch(() => {});
      if (status.active) {
        const backup = status.active !== 'ollama' && status.ollama.running && status.ollama.modelInstalled
          ? ` Local backup: ${status.ollama.activeModel}.` : '';
        s.pushEntry({ who: 'system', text: `Brain online - ${providerLabel(status.active)} ${status.model}.${backup} Team of seven standing by. Hold SPACE to speak.` });
        if (status.gemini.configured && status.gemini.valid === false) {
          s.pushEntry({ who: 'system', text: `Gemini key problem: ${status.gemini.error ?? 'rejected'} - running on the local model meanwhile.`, error: true });
        }
      } else {
        s.pushEntry({
          who: 'system',
          text: 'No AI set up yet - pick one in Settings (Gemini has a free key), or install Ollama for a local model.',
          error: true,
        });
        void ultron.settings.get().then((cfg) => setOverlay({ kind: cfg.setupDone ? 'brain' : 'setup' })).catch(() => setOverlay({ kind: 'brain' }));
      }
    });
    return () => cleanups.forEach((off) => off());
  }, [setOverlay]);

  // Live subscriptions from the main process.
  useEffect(() => {
    const s = useStore.getState();
    const offs = [
      ultron.tasks.onChanged((all) => useStore.getState().setTasks(all)),
      ultron.tasks.onReminder((p) => handleReminder(p)),
      ultron.approvals.onRequest((req) => { useStore.getState().addApproval(req); playAlert(); }),
      ultron.approvals.onSettled(({ id }) => useStore.getState().removeApproval(id)),
      ultron.apps.onChanged((a) => useStore.getState().setApps(a)),
      ultron.browser.onFrame((f) => useStore.getState().setFrame(f)),
      ultron.browser.onClosed((c) => useStore.getState().markBrowserClosed(c.id)),
      ultron.d2l.onChanged((d) => useStore.getState().setD2L(d)),
      ultron.ui.onFocus(({ tab }) => { if (tab) useStore.getState().setRightTab(tab as RightTab); }),
      ultron.vault.onUpdated((u) => {
        const st = useStore.getState();
        st.pushMemoryUpdate(u);
        const what = u.saved.map((x) => (x.created ? `new note "${x.title}"` : `${x.added} fact${x.added === 1 ? '' : 's'} -> ${x.title}`));
        if (u.profileAdded) what.push(`profile +${u.profileAdded}`);
        if (what.length) st.logActivity({ agent: 'mnemosyne', text: `remembered: ${what.join(', ')}`, kind: 'ok' });
      }),
    ];
    const brainPoll = setInterval(() => { void ultron.brain.status().then(s.setBrain); }, 30_000);
    const weatherPoll = setInterval(() => {
      const loc = useStore.getState().settings?.profile.location;
      if (loc) void ultron.research.weather(loc).then(useStore.getState().setWeather);
    }, 20 * 60_000);
    return () => { offs.forEach((off) => off()); clearInterval(brainPoll); clearInterval(weatherPoll); };
  }, []);

  // Speaks first once the brain is ready (never over the operator), then an occasional check-in.
  useEffect(() => { initProactiveGreeting(); return scheduleProactiveCheckIn(45); }, []);

  // Dev hooks used by the ULTRON_CAPTURE screenshot utility and automated checks.
  useEffect(() => {
    (window as unknown as Record<string, unknown>).__ultron = {
      setState: (st: CoreState) => useStore.getState().setCoreState(st),
      closeOverlay: () => useStore.getState().setOverlay(null),
      setTab: (t: RightTab) => useStore.getState().setRightTab(t),
      setOverlay: (o: Overlay) => useStore.getState().setOverlay(o),
      // Evaluations start every task in a fresh conversation, so one task's numbers can't leak into the next.
      clearTranscript: () => useStore.getState().clearTranscript(),
      state: () => {
        const st = useStore.getState();
        return {
          brain: st.brain,
          team: st.team,
          tasks: st.tasks.length,
          transcript: st.transcript.map((t) => ({ who: t.who, text: t.text, error: t.error })),
          browsers: Object.values(st.browsers).map(({ image, ...meta }) => ({ ...meta, bytes: image.length })),
        };
      },
      loadStt: async () => {
        try {
          await ensureModel();
          return 'stt:' + useSttStore.getState().stt;
        } catch (e) {
          return 'stt-error: ' + (e instanceof Error ? e.message : String(e));
        }
      },
      transcribeUrl: async (url: string) => {
        const res = await fetch(url);
        const audio = await decodeToMono16k(await res.arrayBuffer());
        if (!audio) return 'DECODE_FAILED';
        return await transcribe(audio);
      },
    };
  }, []);

  const caption = CAPTION[coreState];
  const hint = coreState === 'thinking' && phaseLabel ? phaseLabel : caption.hint;

  return (
    <>
      <Backdrop />
      <div className="shell">
        <div className="area-top hud-panel">
          <div className="hud-panel__inner"><TopBar /></div>
          <span className="hud-panel__bracket hud-panel__bracket--tr" />
          <span className="hud-panel__bracket hud-panel__bracket--bl" />
        </div>

        <div className="area-left"><NewsPanel /></div>

        <div className="area-center">
          <div className="core-stage">
            <CoreOrb state={coreState} />
            <div className="core-caption">
              <div className="core-caption__state" style={{ color: caption.color }}>{caption.text}</div>
              <div className="core-caption__hint">{hint}</div>
            </div>
            <IdleDashboard />
          </div>
          <VoiceInterface />
        </div>

        <div className="area-right"><SystemPanel /></div>

        <div className="area-bottom"><TranscriptPanel /></div>
      </div>

      <OverlaySuspense>
        {overlay?.kind === 'settings' && <SettingsPanel onClose={() => setOverlay(null)} />}
        {overlay?.kind === 'brain' && <BrainSetup onClose={() => setOverlay(null)} />}
        {overlay?.kind === 'setup' && <FirstRunSetup onClose={() => setOverlay(null)} />}
        {overlay?.kind === 'memory' && <MemoryPanel onClose={() => setOverlay(null)} />}
        {overlay?.kind === 'apps' && <AppsPanel onClose={() => setOverlay(null)} />}
      </OverlaySuspense>

      <CommandPalette open={paletteOpen} onClose={() => setPaletteOpen(false)} />
      {clipboardText && <ClipboardPanel text={clipboardText} onClose={() => setClipboardText(null)} />}
      <ApprovalPrompt />
      <BootSequence />
    </>
  );
}
