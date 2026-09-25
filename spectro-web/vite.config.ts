import { existsSync, mkdirSync, renameSync, rmSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";

const WEB = fileURLToPath(new URL(".", import.meta.url));

/**
 * Card 430, criterion 9: the build writes a manifest of its chunks, and this
 * moves it out of the tracked static folder into dist/ (git-ignored), so the
 * bundle keeps the files it had and the server serves no manifest. The chunk
 * guard (src/state/surfaceChunks.guard.test.ts) builds in memory and reads
 * the manifest from the build's output, not from here.
 */
function manifestOutsideTheBundle(): Plugin {
  return {
    name: "manifest-outside-the-bundle",
    apply: "build",
    writeBundle(options) {
      if (options.dir === undefined) return;
      const written = resolve(options.dir, ".vite/manifest.json");
      if (!existsSync(written)) return;
      const target = resolve(WEB, "dist/build-manifest.json");
      mkdirSync(dirname(target), { recursive: true });
      renameSync(written, target);
      rmSync(resolve(options.dir, ".vite"), { recursive: true, force: true });
    },
  };
}

// spectro-web — the second face of the harness. Dev mode proxies REST and the
// WebSocket to the Spring Boot server on :8080; the production build writes
// straight into spectro-server's static resources so ONE jar serves everything.
export default defineConfig({
  plugins: [react(), manifestOutsideTheBundle()],
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
    manifest: true,
  },
});
