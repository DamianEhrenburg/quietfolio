import { defineConfig, externalizeDepsPlugin } from "electron-vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    build: {
      outDir: "dist-electron",
      lib: {
        entry: "electron/main.ts"
      }
    }
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      outDir: "dist-electron",
      emptyOutDir: false,
      lib: {
        entry: "electron/preload.ts",
        formats: ["cjs"]
      }
    }
  },
  renderer: {
    root: ".",
    plugins: [react()],
    server: {
      host: "127.0.0.1",
      port: 5173,
      strictPort: true
    },
    build: {
      rollupOptions: {
        input: "index.html"
      }
    }
  }
});
