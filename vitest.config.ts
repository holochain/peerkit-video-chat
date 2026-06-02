import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: [
      "packages/*/tests/**/*.test.ts",
      "apps/*/tests/**/*.test.ts",
    ],
    testTimeout: 30_000,
  },
  // webrtc.ts reads these as build-time constants injected by electron-vite's
  // `define` (see apps/desktop/electron.vite.config.ts). Supply test values so
  // the TURN branch — and the relay-only recovery rung — are exercised.
  define: {
    __TURN_REALM__: JSON.stringify("turn.test.example"),
    __TURN_PASSWORD__: JSON.stringify("test-password"),
  },
});
