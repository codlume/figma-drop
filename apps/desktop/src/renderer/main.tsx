import 'virtual:figma-drop/reset.css';

import * as stylex from '@stylexjs/stylex';
import { type ComponentType, StrictMode, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';

import type { ReceiverStatus } from '../shared/receiver';
import { receiverStatusText } from '../shared/receiver-text';
import { color, font, space } from './tokens.stylex';

// C-UI owns `App.tsx`. The glob resolves at build time, to an empty map while the file is absent.
const appModules = import.meta.glob<{ App: ComponentType }>('./App.tsx', { eager: true });
const App = Object.values(appModules)[0]?.App ?? NotInstalled;

const styles = stylex.create({
  view: {
    boxSizing: 'border-box',
    minHeight: '100vh',
    paddingBlock: space.xxl,
    paddingInline: space.xxl,
    backgroundColor: color.background,
    color: color.text,
    fontFamily: font.family,
    fontSize: font.sizeMd,
    lineHeight: font.lineHeight,
    // The hidden title bar leaves nothing else to drag the window by.
    WebkitAppRegion: 'drag',
  },
  title: {
    marginBlock: 0,
    fontSize: font.sizeXl,
    fontWeight: font.weightBold,
  },
  line: {
    marginBlockStart: space.sm,
    marginBlockEnd: 0,
    color: color.textMuted,
  },
});

function NotInstalled() {
  const [status, setStatus] = useState<ReceiverStatus | null>(null);

  useEffect(() => {
    const { receiver } = window.figmaDrop;
    const unsubscribe = receiver.onStatus(setStatus);
    void receiver.getStatus().then((first) => setStatus((latest) => latest ?? first));
    return unsubscribe;
  }, []);

  return (
    <main {...stylex.props(styles.view)}>
      <h1 {...stylex.props(styles.title)}>figma-drop</h1>
      <p {...stylex.props(styles.line)}>The library interface is not installed yet.</p>
      {status && <p {...stylex.props(styles.line)}>{receiverStatusText(status)}</p>}
    </main>
  );
}

const root = document.getElementById('root');
if (!root) throw new Error('index.html has no #root');
createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
