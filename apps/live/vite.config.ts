import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';

export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      manifest: {
        name: 'NestLive',
        short_name: 'NestLive',
        description: 'Operação e orquestração de cultos em tempo real',
        theme_color: '#0B0C11',
        background_color: '#0B0C11',
        display: 'standalone',
        start_url: '/'
      }
    })
  ],
  build: {
    target: 'es2022'
  }
});
