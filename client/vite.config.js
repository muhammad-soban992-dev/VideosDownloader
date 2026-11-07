import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    // host: true (0.0.0.0) is required in Docker so the published port
    // is reachable from the host. Harmless for local `npm run dev` too.
    host: true,
    port: 5173,
    proxy: {
      "/api": "http://localhost:5000",
    },
  },
});
