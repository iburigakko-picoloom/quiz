import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import { AppErrorBoundary } from './components/AppErrorBoundary';
import { AccountStorageGate } from './components/AccountStorageGate';
import { registerServiceWorker } from './registerServiceWorker';
import './index.css';
import './ui-spec.css';
import './final-reference.css';

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <AppErrorBoundary>
      <AccountStorageGate><App /></AccountStorageGate>
    </AppErrorBoundary>
  </React.StrictMode>,
);

registerServiceWorker();
