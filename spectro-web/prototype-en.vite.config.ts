import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Standalone build of the ENGLISH System-Map prototype (src/prototype-en),
// into a self-contained bundle later inlined into a single portable HTML.
export default defineConfig({
  plugins: [react()],
  base: "./",
  build: {
    outDir: "dist-prototype-en",
    emptyOutDir: true,
    rollupOptions: { input: "prototype-en.html" },
  },
});
