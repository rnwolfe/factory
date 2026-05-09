import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import pkg from "./package.json" with { type: "json" };

const proxyTarget = process.env.FACTORY_API ?? "http://127.0.0.1:4080";

const proxy = {
  "/trpc": { target: proxyTarget, changeOrigin: true },
  "/ws": { target: proxyTarget, changeOrigin: true, ws: true },
  "/health": { target: proxyTarget, changeOrigin: true },
};

export default defineConfig({
  // Expose the workspace version to the runtime so the shell + auth-gate
  // chips stay in sync with the release tag without anyone having to
  // remember to update them. Replaced at build time as a string literal.
  define: {
    __FACTORY_VERSION__: JSON.stringify(pkg.version),
  },
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
