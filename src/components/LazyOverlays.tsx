import React, { Suspense } from 'react';

// Overlay panels load on the click that opens them rather than in the main bundle.

export const SettingsPanel = React.lazy(() => import('./SettingsPanel').then((m) => ({ default: m.SettingsPanel })));
export const BrainSetup = React.lazy(() => import('./BrainSetup').then((m) => ({ default: m.BrainSetup })));
export const MemoryPanel = React.lazy(() => import('./MemoryPanel').then((m) => ({ default: m.MemoryPanel })));
export const AppsPanel = React.lazy(() => import('./AppsPanel').then((m) => ({ default: m.AppsPanel })));
export const FirstRunSetup = React.lazy(() => import('./FirstRunSetup').then((m) => ({ default: m.FirstRunSetup })));

export function OverlaySuspense({ children }: { children: React.ReactNode }) {
  return (
    <Suspense
      fallback={
        <div
          className="mono"
          style={{
            display: 'flex', alignItems: 'center', justifyContent: 'center', width: '100%', height: '100%',
            minHeight: '120px', color: 'var(--cyan)', letterSpacing: '0.15em', fontSize: '13px', textShadow: 'var(--text-glow)',
          }}
        >
          LOADING MODULE...
        </div>
      }
    >
      {children}
    </Suspense>
  );
}
