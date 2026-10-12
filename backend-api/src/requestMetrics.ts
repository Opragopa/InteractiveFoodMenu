import { AsyncLocalStorage } from "node:async_hooks";
import type { AppwriteServices } from "./appwrite.js";

export type RequestMetrics = { appwriteCalls: number; appwriteDurationMs: number };
export const requestMetrics = new AsyncLocalStorage<RequestMetrics>();

function measured<T extends object>(service: T): T {
  return new Proxy(service, {
    get(target, key, receiver) {
      const value = Reflect.get(target, key, receiver);
      if (typeof value !== "function") return value;
      return (...args: unknown[]) => {
        const metrics = requestMetrics.getStore();
        if (!metrics) return value.apply(target, args);
        metrics.appwriteCalls += 1;
        const started = performance.now();
        const record = () => { metrics.appwriteDurationMs += performance.now() - started; };
        try {
          const result = value.apply(target, args);
          if (result && typeof result.then === "function") return result.then((data: unknown) => { record(); return data; }, (error: unknown) => { record(); throw error; });
          record();
          return result;
        } catch (error) { record(); throw error; }
      };
    },
  });
}

export function instrumentAppwrite(services: AppwriteServices): AppwriteServices {
  return { ...services, tables: measured(services.tables), storage: measured(services.storage) };
}
