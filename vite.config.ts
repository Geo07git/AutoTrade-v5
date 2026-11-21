import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import path from 'path';
import { defineConfig } from 'vite';

export default defineConfig(() => {
  return {
    plugins: [react(), tailwindcss()],
    resolve: {
      alias: {
        '@': path.resolve(__dirname, '.'),
      },
    },
    server: {
      hmr: process.env.ENABLE_HMR === 'true' && process.env.DISABLE_HMR !== 'true',
      ws: process.env.ENABLE_HMR === 'true' && process.env.DISABLE_HMR !== 'true' ? undefined : (false as const),
      watch: {
        ignored: ['**/.data/**', '.data/**'],
      },
    },
  };
});
