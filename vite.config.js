import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  // FFmpeg WebAssembly needs cross-origin isolation on some browsers for best performance.
  // App still runs without these headers, but certain browser/hosting combinations may be slower.
  server: {
    headers: {
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'require-corp'
    }
  }
});