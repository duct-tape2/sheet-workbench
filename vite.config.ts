import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
export default defineConfig(({ mode }) => {
  const staticDemo =
    mode === "static-demo" || process.env.VITE_STATIC_DEMO === "true";
  return {
    plugins: [react()],
    root: "apps/web",
    define: {
      "import.meta.env.VITE_STATIC_DEMO": JSON.stringify(
        staticDemo ? "true" : "false",
      ),
    },
    server: {
      host: "127.0.0.1",
      port: 5173,
      strictPort: true,
      proxy: { "/api": { target: "http://127.0.0.1:3001", changeOrigin: false } },
    },
    build: {
      outDir: "../../dist/web",
      emptyOutDir: true,
      chunkSizeWarningLimit: 650,
    },
  };
});
