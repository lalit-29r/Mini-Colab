// Entry point mounts <App /> with strict mode.
import React from 'react';
import ReactDOM from 'react-dom/client';
import './index.css';
import '@vscode/codicons/dist/codicon.css';
import App from './App';

const root = ReactDOM.createRoot(
  document.getElementById('root') as HTMLElement
);
root.render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);

// Performance reporting removed to reduce unused code.
