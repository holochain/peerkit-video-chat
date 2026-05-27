import { defineConfig, externalizeDepsPlugin } from "electron-vite";
import { resolve } from "node:path";
import { svelte } from "@sveltejs/vite-plugin-svelte";

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
    build: {
      rollupOptions: {
        input: { index: resolve(__dirname, "src/renderer/index.html") },
      },
    },
  },
});
