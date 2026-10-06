import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';

export default defineConfig({
  base: '/production/',
  plugins: [
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      manifest: {
        name: 'NestLive',
        short_name: 'NestLive',
        description: 'LAN-first live production cockpit for churches',
        theme_color: '#0B0C11',
        background_color: '#0B0C11',
        display: 'standalone',
        start_url: '/production/'
      }
    })
  ],
  server: {
    port: 4316,
    host: '0.0.0.0'
  }
});
