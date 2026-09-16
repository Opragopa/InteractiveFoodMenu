import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./styles.css";
import "./clientLogger";

const rootElement = document.getElementById("root")!;
const root = createRoot(rootElement);
function showStartupError(cause?: unknown) {
  const detail = cause instanceof Error ? cause.message : typeof cause === "string" ? cause : "Причина не определена";
  const message = document.createElement("main");
  message.className = "startup-status startup-error";
  message.textContent = `Не удалось запустить меню: ${detail}. Проверьте подключение и обновите страницу.`;
  while (rootElement.firstChild) rootElement.removeChild(rootElement.firstChild);
  rootElement.appendChild(message);
}

window.addEventListener("error", (event) => {
  // Ignore failed images/scripts/stylesheets; report uncaught JavaScript errors.
  if (event instanceof ErrorEvent) showStartupError(event.error || event.message);
});
window.addEventListener("unhandledrejection", (event) => showStartupError(event.reason));
if (import.meta.env.VITE_DEMO_MODE === "true") {
  import("./DemoApp").then(({ DemoApp }) => root.render(<StrictMode><DemoApp /></StrictMode>)).catch((cause) => showStartupError(cause));
} else {
  import("./App").then(({ App }) => root.render(<StrictMode><App /></StrictMode>)).catch((cause) => showStartupError(cause));
}
