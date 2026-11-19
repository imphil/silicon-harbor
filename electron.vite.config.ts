import { resolve } from "node:path"
import { svelte } from "@sveltejs/vite-plugin-svelte"
import { defineConfig, externalizeDepsPlugin } from "electron-vite"
import type { Plugin } from "vite"

/**
 * carbon-components-svelte's precompiled CSS declares every IBM Plex face with
 * URLs on IBM's CDN (1.www.s81c.com). The app is offline-capable and its CSP
 * only allows fonts from 'self', so those requests fail with console errors.
 * Strip the CDN @font-face rules; src/renderer/src/fonts.css bundles the
 * weights we actually use from @ibm/plex.
 */
function stripCarbonCdnFonts(): Plugin {
  return {
    name: "strip-carbon-cdn-fonts",
    enforce: "pre",
    transform(code, id) {
      if (!/carbon-components-svelte[\\/]css[\\/].*\.css$/.test(id)) return
      return {
        code: code.replace(/@font-face\s*\{[^}]*s81c\.com[^}]*\}/g, ""),
        map: null,
      }
    },
  }
}

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    build: {
      outDir: "dist/main",
      rollupOptions: {
        input: "src/main/index.ts",
      },
    },
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      outDir: "dist/preload",
      rollupOptions: {
        input: "src/preload/index.ts",
        output: {
          format: "cjs",
          entryFileNames: "[name].js",
        },
      },
    },
  },
  renderer: {
    root: "src/renderer",
    plugins: [stripCarbonCdnFonts(), svelte()],
    resolve: {
      alias: {
        $lib: resolve(__dirname, "src/renderer/src/lib"),
        $shared: resolve(__dirname, "src/shared"),
      },
    },
    build: {
      outDir: "dist/renderer",
      rollupOptions: {
        input: resolve(__dirname, "src/renderer/index.html"),
      },
    },
    server: {
      port: 1430,
      strictPort: true,
    },
  },
})
