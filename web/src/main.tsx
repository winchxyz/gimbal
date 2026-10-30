import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './theme/tokens.css';
import './theme/app.css';
import { Shell } from './shell/Shell.tsx';
import { startStream } from './stream/start.ts';

// Started once, outside React, so StrictMode's double effects never open a second connection.
void startStream();

const root = document.getElementById('root');
if (!root) throw new Error('index.html has no #root');
createRoot(root).render(
  <StrictMode>
    <Shell />
  </StrictMode>,
);
