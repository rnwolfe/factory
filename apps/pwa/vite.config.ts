import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    host: true,
    port: 4081,
    proxy: {
      "/trpc": {
        target: process.env.FACTORY_API ?? "http://127.0.0.1:4080",
        changeOrigin: true,
      },
      "/ws": {
        target: process.env.FACTORY_API ?? "http://127.0.0.1:4080",
        ws: true,
        changeOrigin: true,
      },
      "/health": {
        target: process.env.FACTORY_API ?? "http://127.0.0.1:4080",
        changeOrigin: true,
      },
    },
  },
  build: {
    outDir: "dist",
    sourcemap: true,
  },
});
