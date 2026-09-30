/**
 * Whether the window is worth spending animation budget on right now.
 *
 * Chromium already throttles rAF when the page is truly hidden (minimized,
 * occluded), but that does nothing for the much more common case of this
 * window sitting open-but-unfocused behind something else - four
 * independent rAF loops (orb, particles, spectrum, waveform) kept doing
 * full canvas work the whole time. Checked at the top of each frame instead
 * of tearing the loops down, so everything resumes instantly on refocus
 * with no re-subscribe logic needed anywhere.
 */
export const isRenderActive = (): boolean =>
  typeof document !== 'undefined' && !document.hidden && document.hasFocus();
