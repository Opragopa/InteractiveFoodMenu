import test from "node:test";
import assert from "node:assert/strict";
import { accessKeysMatch } from "./backendHub.js";

test("hub access key comparison requires an exact value", () => {
  assert.equal(accessKeysMatch("a-secure-operator-key", "a-secure-operator-key"), true);
  assert.equal(accessKeysMatch("a-secure-operator-key", "another-operator-key"), false);
  assert.equal(accessKeysMatch("short", "a-secure-operator-key"), false);
});
