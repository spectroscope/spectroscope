import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// spectro-web — the second face of the harness. Dev mode proxies REST and the
// WebSocket to the Spring Boot server on :8080; the production build writes
// straight into spectro-server's static resources so ONE jar serves everything.
export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      "/api": "http://localhost:8080",
      "/ws": { target: "http://localhost:8080", ws: true },
    },
  },
  build: {
    // One artifact: the built UI lands in spectro-server's static resources.
    outDir: "../spectro-server/src/main/resources/static",
    emptyOutDir: true,
  },
});
