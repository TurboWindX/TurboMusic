import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const API_PORT = Number(process.env.PORT ?? 3000);

export default defineConfig({
  plugins: [react()],
  server: {
    host: true,
    port: 5173,
    proxy: { '/api': `http://localhost:${API_PORT}` },
  },
  // The sheet-music renderer is one big chunk, loaded only on the sheet page.
  build: { chunkSizeWarningLimit: 1600 },
  test: { environment: 'node' },
} as any);
