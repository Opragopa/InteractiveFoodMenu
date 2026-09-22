import { Client, Storage, TablesDB } from "node-appwrite";
import type { BackendConfig } from "./config.js";

export type AppwriteServices = {
  client: Client;
  tables: TablesDB;
  storage: Storage;
};

export function createAppwriteServices(config: BackendConfig): AppwriteServices {
  const client = new Client()
    .setEndpoint(config.appwriteEndpoint)
    .setProject(config.appwriteProjectId)
    .setKey(config.appwriteApiKey);

  return {
    client,
    tables: new TablesDB(client),
    storage: new Storage(client),
  };
}
