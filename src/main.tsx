import React from 'react';
import ReactDOM from 'react-dom/client';
import { App } from './App';
import './styles/tokens.css';
import './styles/hud.css';
import './styles/core.css';
import './styles/app.css';
import './styles/boot.css';
import './styles/hologram.css';
import './styles/bootlog.css';
import './styles/team.css';
import './styles/a11y.css';

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
