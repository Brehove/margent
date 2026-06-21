import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// @ts-expect-error process is a nodejs global
const host = process.env.TAURI_DEV_HOST;

// https://vite.dev/config/
export default defineConfig(async () => ({
  plugins: [react()],

  build: {
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (!id.includes("node_modules")) {
            return undefined;
          }

          if (/[\\/]node_modules[\\/](react|react-dom|scheduler|zustand)[\\/]/.test(id)) {
            return "vendor-react";
          }

          if (/[\\/]node_modules[\\/]@lezer[\\/]/.test(id)) {
            return "vendor-lezer";
          }

          if (/[\\/]node_modules[\\/]@codemirror[\\/](state|view)[\\/]/.test(id)) {
            return "vendor-codemirror-core";
          }

          if (/[\\/]node_modules[\\/]@codemirror[\\/](language|lang-markdown)[\\/]/.test(id)) {
            return "vendor-codemirror-language";
          }

          if (
            /[\\/]node_modules[\\/]@codemirror[\\/]language-data[\\/]/.test(id) ||
            /[\\/]node_modules[\\/]@codemirror[\\/]legacy-modes[\\/]/.test(id)
          ) {
            return undefined;
          }

          if (/[\\/]node_modules[\\/]@codemirror[\\/]/.test(id)) {
            return "vendor-codemirror-tools";
          }

          if (/[\\/]node_modules[\\/]@tauri-apps[\\/]/.test(id)) {
            return "vendor-tauri";
          }

          return undefined;
        },
      },
    },
  },

  // Vite options tailored for Tauri development and only applied in `tauri dev` or `tauri build`
  //
  // 1. prevent Vite from obscuring rust errors
  clearScreen: false,
  // 2. tauri expects a fixed port, fail if that port is not available
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 1421,
        }
      : undefined,
    watch: {
      // 3. tell Vite to ignore watching `src-tauri`
      ignored: ["**/src-tauri/**"],
    },
  },
}));
