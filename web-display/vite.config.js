import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import legacy from "@vitejs/plugin-legacy";
function webOsLegacyBootstrap() {
    return {
        name: "webos-legacy-bootstrap",
        transformIndexHtml: {
            order: "post",
            handler: function (html) {
                var disabledLegacyTags = html
                    .replace(/<script nomodule([^>]*id="vite-legacy-(?:polyfill|entry)"[^>]*)>/g, '<script type="application/x-vite-legacy"$1>');
                var bootstrap = "<script>(function(){\n          // Chromium 38 on webOS can parse import(...) as an ordinary call,\n          // although it cannot execute ES modules. Identify LG browsers first.\n          var isWebOs = /Web0S|webOS/i.test(navigator.userAgent);\n          var supportsDynamicImport = !isWebOs;\n          try { if (supportsDynamicImport) { new Function(\"return import('data:text/javascript,')\"); } } catch (error) { supportsDynamicImport = false; }\n          if (supportsDynamicImport) return;\n          var polyfill = document.getElementById('vite-legacy-polyfill');\n          var entry = document.getElementById('vite-legacy-entry');\n          if (!polyfill || !entry) return;\n          var script = document.createElement('script');\n          script.src = polyfill.src;\n          script.onload = function () { window.System.import(entry.getAttribute('data-src')); };\n          script.onerror = function () { document.getElementById('root').innerHTML = '<main class=\"startup-status startup-error\">\u041D\u0435 \u0443\u0434\u0430\u043B\u043E\u0441\u044C \u0437\u0430\u0433\u0440\u0443\u0437\u0438\u0442\u044C \u0441\u043E\u0432\u043C\u0435\u0441\u0442\u0438\u043C\u0443\u044E \u0432\u0435\u0440\u0441\u0438\u044E \u043C\u0435\u043D\u044E.</main>'; };\n          document.getElementsByTagName('head')[0].appendChild(script);\n        }());</script>";
                return disabledLegacyTags.replace("</body>", "".concat(bootstrap, "</body>"));
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
                rewrite: function (path) { return "/interactivefoodmenu/europe-west1/renderDisplay".concat(path); },
            },
        },
    },
    test: { environment: "jsdom" },
});
