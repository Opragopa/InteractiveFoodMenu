import { Client, Storage, TablesDB } from "node-appwrite";
import { MenuEvents } from "./menuEvents.js";
import type { Pool } from "pg";
import type { BackendConfig } from "./config.js";

export type AppwriteServices = {
  datastore?: "appwrite" | "postgres";
  events?: MenuEvents;
  pool?: Pool;
  close?: () => Promise<void>;
  client: Client;
  tables: TablesDB;
  storage: Storage;
};

export function createAppwriteServices(config: BackendConfig): AppwriteServices {
  const client = new Client()
    .setEndpoint(config.appwriteEndpoint)
    .setProject(config.appwriteProjectId)
    .setKey(config.appwriteApiKey)
    // Appwrite's Traefik uses a local certificate on the Docker host. This
    // connection never leaves the host network; public client traffic still
    // terminates at Nginx with a normal trusted certificate.
    .setSelfSigned(config.appwriteSelfSigned);

  const events = new MenuEvents();
  const raw = new TablesDB(client);
  const tables = new Proxy(raw, { get(target, key, receiver) {
    const value = Reflect.get(target, key, receiver);
    if (typeof value !== "function") return value;
    return async (...args: any[]) => {
      const result = await value.apply(target, args);
      const arg = args[0];
      if (["createRow", "updateRow", "deleteRow", "incrementRowColumn", "decrementRowColumn"].includes(String(key)) && ["venues", "categories", "items", "display_tokens"].includes(arg?.tableId)) {
        if (arg.tableId !== "display_tokens" || arg.data?.active !== undefined) events.publish(arg.tableId === "venues" ? arg.rowId : String(result?.venueId ?? arg.data?.venueId ?? "*"));
      }
      return result;
    };
  } });
  return {
    datastore: "appwrite", events, client,
    tables,
    storage: new Storage(client),
  };
}

export async function createServices(config: BackendConfig): Promise<AppwriteServices> {
  return config.databaseProvider === "postgres" ? (await import("./postgres.js")).createPostgresServices(config) : createAppwriteServices(config);
}
