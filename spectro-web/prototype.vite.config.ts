import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Standalone build of ONLY the System-Map prototype, into a self-contained
// bundle (later inlined into a single portable HTML). base "./" keeps asset
// paths relative so it also works from file://. Separate outDir so it never
// touches spectro-server's static resources.
export default defineConfig({
  plugins: [react()],
  base: "./",
  build: {
    outDir: "dist-prototype",
    emptyOutDir: true,
    rollupOptions: { input: "prototype-en.html" },
  },
});
