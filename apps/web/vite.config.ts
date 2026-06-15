import { defineConfig } from "vite";

// Served at skynetops.ai/agiwar in production (via a rewrite in the existing
// skynetops Vercel project), so the app is built under the /agiwar/ base path.
export default defineConfig({
  base: process.env.VITE_BASE ?? "/",
  server: { port: 5173 },
});
