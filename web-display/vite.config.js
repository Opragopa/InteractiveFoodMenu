import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import legacy from "@vitejs/plugin-legacy";
var emulatorProxy = {
    "/interactivefoodmenu": {
        target: "http://127.0.0.1:5001",
        changeOrigin: true,
    },
    "/display": {
        target: "http://127.0.0.1:5001",
        rewrite: function (path) { return "/interactivefoodmenu/europe-west1/renderDisplay".concat(path); },
    },
};
function legacyTvBootstrap() {
    return {
        name: "legacy-tv-bootstrap",
        transformIndexHtml: {
            order: "post",
            handler: function (html) {
                var disabledLegacyTags = html
                    .replace(/<script nomodule([^>]*id="vite-legacy-(?:polyfill|entry)"[^>]*)>/g, '<script type="application/x-vite-legacy"$1>');
                var bootstrap = "<script>(function(){\n          // Tizen 5 / Chromium 63 parses modules, but is too old for the\n          // modern bundle. Force these TVs onto Vite's Chrome 38 ES5 bundle.\n          var userAgent = navigator.userAgent || '';\n          var isWebOs = /Web0S|webOS/i.test(userAgent);\n          var tizen = /Tizen\\s+(\\d+(?:\\.\\d+)?)/i.exec(userAgent);\n          var isLegacySamsung = /SMART-TV|TV Safari/i.test(userAgent) && tizen && parseFloat(tizen[1]) < 6;\n          var forceLegacy = isWebOs || isLegacySamsung;\n          var supportsDynamicImport = !forceLegacy;\n          try { if (supportsDynamicImport) { new Function(\"return import('data:text/javascript,')\"); } } catch (error) { supportsDynamicImport = false; }\n          if (supportsDynamicImport) return;\n          var polyfill = document.getElementById('vite-legacy-polyfill');\n          var entry = document.getElementById('vite-legacy-entry');\n          // Samsung Tizen 5 supports modules syntactically; remove modern\n          // entry scripts before the browser executes them.\n          var scripts = document.getElementsByTagName('script');\n          for (var index = scripts.length - 1; index >= 0; index--) {\n            if ((scripts[index].type || '').toLowerCase() === 'module') scripts[index].parentNode.removeChild(scripts[index]);\n          }\n          if (!polyfill || !entry) {\n            document.getElementById('root').innerHTML = '<main class=\"startup-status startup-error\">\u0421\u0431\u043E\u0440\u043A\u0430 \u0434\u043B\u044F \u0441\u0442\u0430\u0440\u043E\u0433\u043E \u0422\u0412 \u043D\u0435 \u043D\u0430\u0439\u0434\u0435\u043D\u0430. \u0417\u0430\u043F\u0443\u0441\u0442\u0438\u0442\u0435 npm run tv \u0438 \u043E\u0442\u043A\u0440\u043E\u0439\u0442\u0435 \u0430\u0434\u0440\u0435\u0441 \u0441 \u043F\u043E\u0440\u0442\u043E\u043C 5174.</main>';\n            return;\n          }\n          var script = document.createElement('script');\n          script.src = polyfill.src;\n          script.onload = function () { window.System.import(entry.getAttribute('data-src')); };\n          script.onerror = function () { document.getElementById('root').innerHTML = '<main class=\"startup-status startup-error\">\u041D\u0435 \u0443\u0434\u0430\u043B\u043E\u0441\u044C \u0437\u0430\u0433\u0440\u0443\u0437\u0438\u0442\u044C \u0441\u043E\u0432\u043C\u0435\u0441\u0442\u0438\u043C\u0443\u044E \u0432\u0435\u0440\u0441\u0438\u044E \u043C\u0435\u043D\u044E.</main>'; };\n          document.getElementsByTagName('head')[0].appendChild(script);\n        }());</script>";
                return disabledLegacyTags.replace("</body>", "".concat(bootstrap, "</body>"));
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
