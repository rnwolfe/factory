import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const proxyTarget = process.env.FACTORY_API ?? "http://127.0.0.1:4080";

const proxy = {
  "/trpc": { target: proxyTarget, changeOrigin: true },
  "/ws": { target: proxyTarget, changeOrigin: true, ws: true },
  "/health": { target: proxyTarget, changeOrigin: true },
};

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    host: true, // bind 0.0.0.0 so phones on the LAN can reach it
    port: 4081,
    strictPort: false, // step to the next free port if 4081 is taken
    proxy,
  },
  preview: {
    host: true,
    port: 4081,
    strictPort: false,
    proxy,
  },
  build: {
    outDir: "dist",
    sourcemap: true,
  },
});
