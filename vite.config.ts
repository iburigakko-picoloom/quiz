import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import type { Plugin } from "vite";
import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// Keep Japanese CMaps, standard fonts and image decoders available offline.
const pdfAssetsPlugin: Plugin = {
  name: 'quiz-pdf-assets',
  configureServer(server) {
    server.middlewares.use((req, res, next) => {
      const match = req.url?.match(/\/assets\/pdfjs\/(cmaps|standard_fonts|wasm)\/([A-Za-z0-9_.-]+)$/);
      if (!match) return next();
      const directory = resolve('node_modules/pdfjs-dist', match[1]);
      if (!readdirSync(directory).includes(match[2])) return next();
      res.setHeader('Content-Type', match[2].endsWith('.wasm') ? 'application/wasm' : match[2].endsWith('.js') ? 'text/javascript' : 'application/octet-stream');
      res.end(readFileSync(resolve(directory, match[2])));
    });
  },
  generateBundle() {
    for (const directory of ['cmaps', 'standard_fonts', 'wasm']) {
      for (const file of readdirSync(resolve('node_modules/pdfjs-dist', directory))) {
        this.emitFile({ type: 'asset', fileName: `assets/pdfjs/${directory}/${file}`, source: readFileSync(resolve('node_modules/pdfjs-dist', directory, file)) });
      }
    }
  },
};

const buildId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
const buildVersionPlugin: Plugin = {
  name: "quiz-build-version",
  transformIndexHtml(html: string) {
    return html.replace(
      "<head>",
      `<head>\n    <meta name="quiz-build-id" content="${buildId}" />`,
    );
  },
};

const precacheManifestPlugin: Plugin = {
  name: "quiz-precache-manifest",
  apply: "build",
  generateBundle(_options, bundle) {
    const files = Object.keys(bundle)
      .filter((fileName) => fileName.startsWith("assets/") && !fileName.endsWith(".map"))
      .sort();

    this.emitFile({
      type: "asset",
      fileName: "precache-manifest.json",
      source: `${JSON.stringify({ version: 1, files }, null, 2)}\n`,
    });
  },
};

export default defineConfig(({ mode }) => ({
  base: mode === "native" ? "./" : "/quiz/",
  plugins: [react(), buildVersionPlugin, pdfAssetsPlugin, precacheManifestPlugin],
  define: {
    __QUIZ_BUILD_ID__: JSON.stringify(buildId),
  },
}));
