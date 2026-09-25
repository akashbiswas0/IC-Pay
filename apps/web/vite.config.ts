import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
export default defineConfig({
  plugins: [react()],
  // Preserve the SDK WASM file URL instead of prebundling it into .vite/deps.
  optimizeDeps: { exclude: ["@worldcoin/idkit-core"] },
  server: {
    port: 5173,
    proxy: {
      "/v1": "http://127.0.0.1:3001",
      "/health": "http://127.0.0.1:3001",
    },
  },
});
