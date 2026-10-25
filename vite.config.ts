import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const SERVER_PORT = Number(process.env.PORT ?? 8787);

// В dev-режиме Vite отдаёт фронтенд, а API и WebSocket проксируются на сервер.
// В production сервер сам раздаёт собранный dist/, и всё живёт на одном порту.
export default defineConfig({
  plugins: [react()],
  server: {
    host: true,
    port: 5173,
    allowedHosts: true,
    proxy: {
      "/api": `http://localhost:${SERVER_PORT}`,
      "/ws": { target: `ws://localhost:${SERVER_PORT}`, ws: true },
    },
  },
  build: {
    outDir: "dist",
    sourcemap: false,
  },
});
