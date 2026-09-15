import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import legacy from "@vitejs/plugin-legacy";

const emulatorProxy = {
  "/interactivefoodmenu": {
    target: "http://127.0.0.1:5001",
    changeOrigin: true,
  },
  "/display": {
    target: "http://127.0.0.1:5001",
    rewrite: (path: string) => `/interactivefoodmenu/europe-west1/renderDisplay${path}`,
  },
};

function legacyTvBootstrap() {
  return {
    name: "legacy-tv-bootstrap",
    transformIndexHtml: {
      order: "post" as const,
      handler(html: string) {
        const disabledLegacyTags = html
          .replace(/<script nomodule([^>]*id="vite-legacy-(?:polyfill|entry)"[^>]*)>/g, '<script type="application/x-vite-legacy"$1>');
        const bootstrap = `<script>(function(){
          // Tizen 5 / Chromium 63 parses modules, but is too old for the
          // modern bundle. Force these TVs onto Vite's Chrome 38 ES5 bundle.
          var userAgent = navigator.userAgent || '';
          var isWebOs = /Web0S|webOS/i.test(userAgent);
          var tizen = /Tizen\\s+(\\d+(?:\\.\\d+)?)/i.exec(userAgent);
          var isLegacySamsung = /SMART-TV|TV Safari/i.test(userAgent) && tizen && parseFloat(tizen[1]) < 6;
          var forceLegacy = isWebOs || isLegacySamsung;
          var supportsDynamicImport = !forceLegacy;
          try { if (supportsDynamicImport) { new Function("return import('data:text/javascript,')"); } } catch (error) { supportsDynamicImport = false; }
          if (supportsDynamicImport) return;
          var polyfill = document.getElementById('vite-legacy-polyfill');
          var entry = document.getElementById('vite-legacy-entry');
          // Samsung Tizen 5 supports modules syntactically; remove modern
          // entry scripts before the browser executes them.
          var scripts = document.getElementsByTagName('script');
          for (var index = scripts.length - 1; index >= 0; index--) {
            if ((scripts[index].type || '').toLowerCase() === 'module') scripts[index].parentNode.removeChild(scripts[index]);
          }
          if (!polyfill || !entry) {
            document.getElementById('root').innerHTML = '<main class="startup-status startup-error">Сборка для старого ТВ не найдена. Запустите npm run tv и откройте адрес с портом 5174.</main>';
            return;
          }
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
    // Older Samsung and LG TVs can use Vite's ES5 bundle and runtime polyfills.
    legacy({ targets: ["Chrome >= 38", "Safari >= 7"], renderLegacyChunks: true }),
    // Older TV engines may pass Vite's module probe but still fail on modern JS.
    legacyTvBootstrap(),
  ],
  server: {
    proxy: emulatorProxy,
  },
  preview: { proxy: emulatorProxy },
  test: { environment: "jsdom" },
});
