// The viewer's entry point: reads the embedded review data and renders the app.
import './zod-config.ts';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.tsx';
import { loadReviewData } from './data.ts';
import './styles.css';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App result={loadReviewData(document)} />
  </StrictMode>,
);
