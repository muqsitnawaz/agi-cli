import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { Dashboard } from './components/core/Dashboard.js';
import './index.css';

const root = document.getElementById('root');

if (!root) {
  throw new Error('agents-dbg root element was not found');
}

createRoot(root).render(
  <StrictMode>
    <Dashboard />
  </StrictMode>,
);
