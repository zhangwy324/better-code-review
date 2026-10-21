// The page's Content-Security-Policy (vite.config.ts) forbids eval, which zod would otherwise probe
// for and the browser report as a violation. zod reads this when each schema is created, so
// main.tsx imports this module before any other.
import { z } from 'zod';

z.config({ jitless: true });
