import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      // Same-origin API in dev: the gateway model (ADR-021) in miniature.
      '/api': 'http://localhost:8080',
    },
  },
});