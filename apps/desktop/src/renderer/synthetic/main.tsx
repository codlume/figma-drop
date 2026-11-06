import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from '../App.tsx';
import {
  createSyntheticBridge,
  scenarioNames,
  type SyntheticControl,
} from './createSyntheticBridge.ts';

declare global {
  interface Window {
    __synthetic?: SyntheticControl;
  }
}

const BANNER_HEIGHT = 28;

const params = new URLSearchParams(window.location.search);
const scenario = scenarioNames.find((name) => name === params.get('scenario')) ?? 'populated';

const { bridge, control } = createSyntheticBridge({
  scenario,
  latencyMs: Number(params.get('latency')) || 0,
  copyCancelled: params.get('copy') === 'cancelled',
  trashAlreadyGone: params.get('trash') === 'gone',
});

Object.defineProperty(window, 'figmaDrop', { value: bridge });
window.__synthetic = control;

const root = document.getElementById('root');
if (!root) throw new Error('synthetic.html has no #root');

createRoot(root).render(
  <StrictMode>
    <div
      role="note"
      style={{
        position: 'fixed',
        inset: '0 0 auto 0',
        height: BANNER_HEIGHT,
        zIndex: 2147483647,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        background: '#8a1c1c',
        color: '#ffffff',
        font: '600 13px system-ui, sans-serif',
      }}
    >
      Synthetic data, not your library. Scenario: {scenario}
    </div>
    {/* The transform keeps the app's own fixed elements below the banner. */}
    <div
      style={{
        position: 'fixed',
        inset: `${BANNER_HEIGHT}px 0 0 0`,
        overflow: 'auto',
        transform: 'translateZ(0)',
      }}
    >
      <App />
    </div>
  </StrictMode>,
);
