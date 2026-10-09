import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    // Le web et le futur mobile consomment la MÊME API : en dev, on la proxifie pour éviter le CORS.
    proxy: { '/api': { target: 'http://localhost:3000', changeOrigin: true } },
  },
});
