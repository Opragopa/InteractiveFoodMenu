import assert from "node:assert/strict";
import test from "node:test";
import { ApiError, normalizeBulkAvailabilityIds } from "./routes.js";

test("bulk availability normalizes duplicate item ids", () => {
  assert.deepEqual(normalizeBulkAvailabilityIds(["a", "a", " b "]), ["a", "b"]);
});

test("bulk availability rejects an empty selection", () => {
  assert.throws(() => normalizeBulkAvailabilityIds(["", "  "]), (error: unknown) => error instanceof ApiError && error.status === 400);
});

test("bulk availability limits a single operation to 500 items", () => {
  assert.throws(() => normalizeBulkAvailabilityIds(Array.from({ length: 501 }, (_, index) => `item-${index}`)), (error: unknown) => error instanceof ApiError && error.status === 400);
});
