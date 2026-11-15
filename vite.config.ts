import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Renderer only. Electron loads the built files from dist/renderer via file://,
// so assets must use relative paths.
export default defineConfig({
  root: ".",
  base: "./",
  plugins: [react()],
  build: {
    outDir: "dist/renderer",
    emptyOutDir: true,
  },
});
