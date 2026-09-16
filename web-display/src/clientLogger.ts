import { httpsCallable } from "firebase/functions";
import { functions } from "./firebase";

type Level = "info" | "warn" | "error";
type Details = Record<string, string | number | boolean | undefined>;

function redact(value: unknown, maximum = 500) {
  return String(value ?? "")
    .replace(/(pin|secret|token|password)=[^\s&]+/gi, "$1=[redacted]")
    .replace(/#[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]{20,}/g, "#[redacted]")
    .slice(0, maximum);
}

function safeDetails(details: Details = {}) {
  return Object.fromEntries(Object.entries(details)
    .filter(([, value]) => typeof value === "string" || typeof value === "number" || typeof value === "boolean")
    .slice(0, 12)
    .map(([key, value]) => [key, typeof value === "string" ? redact(value, 200) : value]));
}

export function reportClientLog(level: Level, event: string, message = "", details: Details = {}) {
  console[level](`[${event}]`, message, safeDetails(details));
  void httpsCallable(functions, "reportClientLog")({ level, event, message: redact(message), details: safeDetails(details) }).catch(() => undefined);
}

export function reportClientError(event: string, error: unknown, details: Details = {}) {
  const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error ?? "Unknown error");
  reportClientLog("error", event, message, details);
}

addEventListener("error", (event) => reportClientError("web_uncaught_error", event.error ?? event.message, { path: location.pathname }));
addEventListener("unhandledrejection", (event) => reportClientError("web_unhandled_rejection", event.reason, { path: location.pathname }));
