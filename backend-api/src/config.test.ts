import test from "node:test";
import assert from "node:assert/strict";
import { loadConfig } from "./config.js";

test("backend refuses short secrets", () => {
  const original = process.env;
  process.env = {
    ...original,
    PUBLIC_URL: "https://api.example.test",
    DISPLAY_BASE_URL: "https://menu.example.test",
    APPWRITE_ENDPOINT: "http://appwrite/v1",
    APPWRITE_SELF_SIGNED: "false",
    APPWRITE_PROJECT_ID: "menu",
    APPWRITE_API_KEY: "short",
    BACKEND_SESSION_SECRET: "short",
    BACKEND_HUB_ACCESS_KEY: "short",
  };
  assert.throws(loadConfig, /APPWRITE_API_KEY/);
  process.env = original;
});
