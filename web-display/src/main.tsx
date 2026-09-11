import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./styles.css";

const rootElement = document.getElementById("root")!;
const root = createRoot(rootElement);
function showStartupError() {
  rootElement.innerHTML = '<main class="startup-status startup-error">Не удалось запустить меню. Проверьте подключение к сети и обновите страницу.</main>';
}

window.addEventListener("error", showStartupError);
window.addEventListener("unhandledrejection", showStartupError);
if (import.meta.env.VITE_DEMO_MODE === "true") {
  import("./DemoApp").then(({ DemoApp }) => root.render(<StrictMode><DemoApp /></StrictMode>)).catch(showStartupError);
} else {
  import("./App").then(({ App }) => root.render(<StrictMode><App /></StrictMode>)).catch(showStartupError);
}
