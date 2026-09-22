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
    .setKey(config.appwriteApiKey)
    // Appwrite's Traefik uses a local certificate on the Docker host. This
    // connection never leaves the host network; public client traffic still
    // terminates at Nginx with a normal trusted certificate.
    .setSelfSigned(config.appwriteSelfSigned);

  return {
    client,
    tables: new TablesDB(client),
    storage: new Storage(client),
  };
}
