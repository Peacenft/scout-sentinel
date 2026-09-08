import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react()],
  root: "web",
  build: {
    outDir: "../dist/public",
    emptyOutDir: true,
    sourcemap: true
  },
  server: {
    host: "127.0.0.1",
    port: 3000,
    proxy: {
      "/v1": "http://127.0.0.1:4100",
      "/health": "http://127.0.0.1:4100"
    }
  }
});
