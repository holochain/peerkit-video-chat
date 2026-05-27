import { defineConfig, externalizeDepsPlugin } from "electron-vite";
import { resolve } from "node:path";
import { createRequire } from "node:module";
import { svelte } from "@sveltejs/vite-plugin-svelte";

const require = createRequire(import.meta.url);
const { version: APP_VERSION } = require("./package.json") as { version: string };

export default defineConfig({
  main: {
    plugins: [
      externalizeDepsPlugin({ exclude: ["@peerkit-video-chat/core"] }),
    ],
    resolve: {
      alias: {
        "@peerkit-video-chat/core": resolve(
          __dirname,
          "../../packages/core/src/index.ts",
        ),
      },
    },
    build: {
      rollupOptions: {
        input: { index: resolve(__dirname, "src/main/index.ts") },
      },
    },
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        input: { index: resolve(__dirname, "src/preload/index.ts") },
        output: {
          format: "cjs",
          entryFileNames: "[name].js",
        },
      },
    },
  },
  renderer: {
    root: resolve(__dirname, "src/renderer"),
    plugins: [svelte()],
    define: {
      __APP_VERSION__: JSON.stringify(APP_VERSION),
    },
    build: {
      rollupOptions: {
        input: { index: resolve(__dirname, "src/renderer/index.html") },
      },
    },
  },
});
