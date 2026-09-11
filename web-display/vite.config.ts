import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import legacy from "@vitejs/plugin-legacy";

function webOsLegacyBootstrap() {
  return {
    name: "webos-legacy-bootstrap",
    transformIndexHtml: {
      order: "post" as const,
      handler(html: string) {
        const disabledLegacyTags = html
          .replace(/<script nomodule([^>]*id="vite-legacy-(?:polyfill|entry)"[^>]*)>/g, '<script type="application/x-vite-legacy"$1>');
        const bootstrap = `<script>(function(){
          // Chromium 38 on webOS can parse import(...) as an ordinary call,
          // although it cannot execute ES modules. Identify LG browsers first.
          var isWebOs = /Web0S|webOS/i.test(navigator.userAgent);
          var supportsDynamicImport = !isWebOs;
          try { if (supportsDynamicImport) { new Function("return import('data:text/javascript,')"); } } catch (error) { supportsDynamicImport = false; }
          if (supportsDynamicImport) return;
          var polyfill = document.getElementById('vite-legacy-polyfill');
          var entry = document.getElementById('vite-legacy-entry');
          if (!polyfill || !entry) return;
          var script = document.createElement('script');
          script.src = polyfill.src;
          script.onload = function () { window.System.import(entry.getAttribute('data-src')); };
          script.onerror = function () { document.getElementById('root').innerHTML = '<main class="startup-status startup-error">Не удалось загрузить совместимую версию меню.</main>'; };
          document.getElementsByTagName('head')[0].appendChild(script);
        }());</script>`;
        return disabledLegacyTags.replace("</body>", `${bootstrap}</body>`);
      },
    },
  };
}

export default defineConfig({
  plugins: [
    react(),
    // webOS 1/2 use WebKit, while webOS 3/4 use Chromium 38/53. Vite emits
    // a nomodule ES5 bundle and the required runtime polyfills for both.
    legacy({ targets: ["Chrome >= 38", "Safari >= 7"], renderLegacyChunks: true }),
    // Some LG engines expose `nomodule` but still cannot run Vite's module
    // probe. Load the ES5 bundle explicitly after a syntax-level probe.
    webOsLegacyBootstrap(),
  ],
  server: {
    proxy: {
      "/display": {
        target: "http://127.0.0.1:5001",
        rewrite: (path) => `/interactivefoodmenu/europe-west1/renderDisplay${path}`,
      },
    },
  },
  test: { environment: "jsdom" },
});
