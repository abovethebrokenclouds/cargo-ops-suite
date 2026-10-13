import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import path from "node:path";

export default defineConfig({
  plugins: [react()],
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: ["./src/test/setup.ts"],
    include: ["src/**/*.{test,spec}.{ts,tsx}", "packages/**/*.test.ts"],
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
      "@cargo-ops/protocol": path.resolve(__dirname, "./packages/protocol/src/index.ts"),
      "@cargo-ops/economy": path.resolve(__dirname, "./packages/economy/src/index.ts"),
    },
  },
});
