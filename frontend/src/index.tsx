// Entry point mounts <App /> with strict mode.
import React from 'react';
import ReactDOM from 'react-dom/client';
import './index.css';
import '@vscode/codicons/dist/codicon.css';
import App from './App';

// Polyfill: some environments lack KeyboardEvent.getModifierState used by Monaco
try {
  const KEP: any = (window as any).KeyboardEvent && (window as any).KeyboardEvent.prototype;
  if (KEP && typeof KEP.getModifierState !== 'function') {
    KEP.getModifierState = function(mod: string) {
      const key = (mod || '').toLowerCase();
      switch (key) {
        case 'shift':
          return !!this.shiftKey;
        case 'alt':
          return !!this.altKey;
        case 'control':
        case 'ctrl':
          return !!this.ctrlKey;
        case 'meta':
        case 'os':
          return !!this.metaKey;
        default:
          return false;
      }
    };
    // Also ensure location exists to avoid downstream assumptions
    if (typeof KEP.location === 'undefined') {
      KEP.location = 0;
    }
  }
} catch {}

const root = ReactDOM.createRoot(
  document.getElementById('root') as HTMLElement
);
root.render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);

// Performance reporting removed to reduce unused code.
