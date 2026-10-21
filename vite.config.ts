// Builds the viewer (src/viewer) into dist/viewer. The renderer (#28) inlines that bundle and the
// review data into one review.html; `npm run viewer` serves it with a review's data for development.
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  root: 'src/viewer',
  base: './',
  plugins: [react()],
  build: { outDir: '../../dist/viewer', emptyOutDir: true },
});
