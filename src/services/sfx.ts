/**
 * sfx.ts — synthesized UI sound effects (pure Web Audio API, no audio files).
 *
 * Real call sites (see proposals/sound-design.md for full detail):
 *   - src/components/BootSequence.tsx   — top of mount useEffect (~line 31): playBootChime()
 *   - src/components/VoiceInterface.tsx — `down` keydown handler (~line 57), before beginPushToTalk(): playClick()
 *   - src/components/VoiceInterface.tsx — toggleLiveVoice() (~line 41), after res.ok confirms session start: playConfirm()
 *   - src/services/wakeWord.ts          — runLoop() (~line 74), immediately before onWake(): playWakeDetected()
 *   - src/services/conversation.ts      — wherever an error/failure path surfaces to the user
 *     (mic denied, model load failure, live session error; pairs with setLiveError/sttReason
 *     in VoiceInterface.tsx): playAlert()
 */

let ctx: AudioContext | null = null;

function getCtx(): AudioContext {
  if (!ctx) ctx = new AudioContext();
  if (ctx.state === 'suspended') void ctx.resume();
  return ctx;
}

/**
 * Two-stage boot sound: a 220Hz->440Hz triangle sweep over 400ms (gain 0->0.15
 * over a 40ms attack, then held), layered with a 1760Hz sine "shimmer" starting
 * at 300ms, lasting 120ms, gain 0.1 with a fast exponential decay to 0.001.
 * Total duration ~550ms.
 */
export function playBootChime(): void {
  try {
    const c = getCtx();
    const now = c.currentTime;

    // Stage 1: 220Hz -> 440Hz triangle sweep, 400ms
    const sweepOsc = c.createOscillator();
    sweepOsc.type = 'triangle';
    sweepOsc.frequency.setValueAtTime(220, now);
    sweepOsc.frequency.linearRampToValueAtTime(440, now + 0.4);

    const sweepGain = c.createGain();
    sweepGain.gain.setValueAtTime(0, now);
    sweepGain.gain.linearRampToValueAtTime(0.15, now + 0.04);
    sweepGain.gain.setValueAtTime(0.15, now + 0.4);

    sweepOsc.connect(sweepGain);
    sweepGain.connect(c.destination);

    sweepOsc.start(now);
    sweepOsc.stop(now + 0.4);
    sweepOsc.onended = () => {
      sweepOsc.disconnect();
      sweepGain.disconnect();
    };

    // Stage 2: 1760Hz sine shimmer, starts at 300ms, lasts 120ms
    const shimmerStart = now + 0.3;
    const shimmerOsc = c.createOscillator();
    shimmerOsc.type = 'sine';
    shimmerOsc.frequency.setValueAtTime(1760, shimmerStart);

    const shimmerGain = c.createGain();
    shimmerGain.gain.setValueAtTime(0.1, shimmerStart);
    shimmerGain.gain.exponentialRampToValueAtTime(0.001, shimmerStart + 0.12);

    shimmerOsc.connect(shimmerGain);
    shimmerGain.connect(c.destination);

    shimmerOsc.start(shimmerStart);
    shimmerOsc.stop(shimmerStart + 0.12);
    shimmerOsc.onended = () => {
      shimmerOsc.disconnect();
      shimmerGain.disconnect();
    };
  } catch {
    // silently no-op
  }
}

/**
 * Tactile click: single 1200Hz square oscillator, 15ms, gain envelope instant
 * attack to 0.06 then exponential decay to 0.001 by 15ms, filtered through a
 * lowpass biquad at 4000Hz to soften square-wave harshness.
 */
export function playClick(): void {
  try {
    const c = getCtx();
    const now = c.currentTime;
    const duration = 0.015;

    const osc = c.createOscillator();
    osc.type = 'square';
    osc.frequency.setValueAtTime(1200, now);

    const filter = c.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.setValueAtTime(4000, now);

    const gain = c.createGain();
    gain.gain.setValueAtTime(0.06, now);
    gain.gain.exponentialRampToValueAtTime(0.001, now + duration);

    osc.connect(filter);
    filter.connect(gain);
    gain.connect(c.destination);

    osc.start(now);
    osc.stop(now + duration);
    osc.onended = () => {
      osc.disconnect();
      filter.disconnect();
      gain.disconnect();
    };
  } catch {
    // silently no-op
  }
}

/**
 * Affirmative confirmation: sine oscillator sweeping 880Hz->1760Hz over 120ms
 * (exponential frequency ramp), gain 0.12 with fast exponential decay starting
 * at 60ms, floor by 140ms.
 */
export function playConfirm(): void {
  try {
    const c = getCtx();
    const now = c.currentTime;

    const osc = c.createOscillator();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(880, now);
    osc.frequency.exponentialRampToValueAtTime(1760, now + 0.12);

    const gain = c.createGain();
    gain.gain.setValueAtTime(0.12, now);
    gain.gain.setValueAtTime(0.12, now + 0.06);
    gain.gain.exponentialRampToValueAtTime(0.001, now + 0.14);

    osc.connect(gain);
    gain.connect(c.destination);

    osc.start(now);
    osc.stop(now + 0.14);
    osc.onended = () => {
      osc.disconnect();
      gain.disconnect();
    };
  } catch {
    // silently no-op
  }
}

/**
 * Urgent alert: two 660Hz square-wave pulses, 80ms each, with a 60ms silent
 * gap between them (no decay tail in the gap — hard silence). Gain 0.1 per
 * pulse with linear decay. Second pulse detuned +5 cents to avoid sounding
 * like a phone ringtone. Total ~220ms.
 */
export function playAlert(): void {
  try {
    const c = getCtx();
    const now = c.currentTime;
    const pulseDuration = 0.08;
    const gap = 0.06;

    const makePulse = (startTime: number, detuneCents: number) => {
      const osc = c.createOscillator();
      osc.type = 'square';
      osc.frequency.setValueAtTime(660, startTime);
      osc.detune.setValueAtTime(detuneCents, startTime);

      const gain = c.createGain();
      gain.gain.setValueAtTime(0.1, startTime);
      gain.gain.linearRampToValueAtTime(0, startTime + pulseDuration);

      osc.connect(gain);
      gain.connect(c.destination);

      osc.start(startTime);
      osc.stop(startTime + pulseDuration);
      osc.onended = () => {
        osc.disconnect();
        gain.disconnect();
      };
    };

    // First pulse: 0ms -> 80ms
    makePulse(now, 0);
    // Gap: 80ms -> 140ms (silence)
    // Second pulse: 140ms -> 220ms, +5 cents detune
    makePulse(now + pulseDuration + gap, 5);
  } catch {
    // silently no-op
  }
}

/**
 * Wake-word confirmation ping: sine oscillator, fixed 523Hz (C5), 90ms, gain
 * envelope 0->0.1 over a 10ms attack, held to 60ms, exponential decay to
 * 0.001 by 90ms. Distinct from playConfirm()'s sweep so the two are never
 * confused by ear.
 */
export function playWakeDetected(): void {
  try {
    const c = getCtx();
    const now = c.currentTime;

    const osc = c.createOscillator();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(523, now);

    const gain = c.createGain();
    gain.gain.setValueAtTime(0, now);
    gain.gain.linearRampToValueAtTime(0.1, now + 0.01);
    gain.gain.setValueAtTime(0.1, now + 0.06);
    gain.gain.exponentialRampToValueAtTime(0.001, now + 0.09);

    osc.connect(gain);
    gain.connect(c.destination);

    osc.start(now);
    osc.stop(now + 0.09);
    osc.onended = () => {
      osc.disconnect();
      gain.disconnect();
    };
  } catch {
    // silently no-op
  }
}
