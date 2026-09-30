/** Fixed ambient layers behind everything: grid, vignette, scanlines, sweep. */
export function Backdrop() {
  return (
    <>
      <div className="bg-layer bg-grid" />
      <div className="bg-layer bg-grid--fine" />
      <div className="bg-layer bg-vignette" />
      <div className="bg-layer bg-scanlines" />
      <div className="bg-layer bg-sweep" />
      <div className="bg-layer holo-particles" style={{ position: 'fixed', inset: 0, pointerEvents: 'none' }} />
    </>
  );
}
