import test, { after, before } from "node:test";
import { readFile } from "node:fs/promises";
import assert from "node:assert/strict";
import {
  assertFails,
  assertSucceeds,
  initializeTestEnvironment,
  type RulesTestEnvironment,
} from "@firebase/rules-unit-testing";

let environment: RulesTestEnvironment;
const projectId = "demo-interactive-menu";
const venue = {
  name: "Кафе",
  currency: "RUB",
  backgroundColor: "#F7F4EE",
  accentColor: "#9C3D24",
  logoPath: "",
  pageDurationSeconds: 10,
  displayScalePercent: 100,
  displayVersion: 2,
  staffVersion: 3,
  updatedAt: new Date(),
  updatedBy: "setup",
};

before(async () => {
  environment = await initializeTestEnvironment({
    projectId,
    firestore: { rules: await readFile("../firestore.rules", "utf8") },
  });
  await environment.withSecurityRulesDisabled(async (context) => {
    const db = context.firestore();
    await db.doc("venues/main").set(venue);
    await db.doc("venues/other").set({ ...venue, name: "Другая точка" });
    await db.doc("categories/main-food").set({ venueId: "main", name: "Кухня", sortOrder: 0, updatedAt: new Date(), updatedBy: "setup" });
    await db.doc("items/main-soup").set({ venueId: "main", categoryId: "main-food", name: "Суп", priceMinor: 25000, sortOrder: 0, isAvailable: true, updatedAt: new Date(), updatedBy: "setup" });
    await db.doc("items/other-soup").set({ venueId: "other", categoryId: "other-food", name: "Чужой суп", priceMinor: 1, sortOrder: 0, isAvailable: true, updatedAt: new Date(), updatedBy: "setup" });
  });
});

after(async () => environment.cleanup());

test("display can read its current venue but cannot write", async () => {
  const db = environment.authenticatedContext("display", { role: "display", venueId: "main", displayVersion: 2 }).firestore();
  await assertSucceeds(db.doc("venues/main").get());
  await assertSucceeds(db.doc("items/main-soup").get());
  await assertFails(db.doc("items/main-soup").update({ isAvailable: false }));
});

test("rotated display token and anonymous clients are denied", async () => {
  const oldDisplay = environment.authenticatedContext("old", { role: "display", venueId: "main", displayVersion: 1 }).firestore();
  await assertFails(oldDisplay.doc("venues/main").get());
  await assertFails(environment.unauthenticatedContext().firestore().doc("venues/main").get());
});

test("staff can update only its venue with valid fields", async () => {
  const db = environment.authenticatedContext("staff", { role: "staff", venueId: "main", staffVersion: 3 }).firestore();
  await assertSucceeds(db.doc("venues/main").update({ displayScalePercent: 150, updatedAt: new Date(), updatedBy: "staff" }));
  await assertFails(db.doc("venues/main").update({ displayScalePercent: 170, updatedAt: new Date(), updatedBy: "staff" }));
  await assertSucceeds(db.doc("items/main-soup").update({ isAvailable: false, updatedAt: new Date(), updatedBy: "staff" }));
  await assertFails(db.doc("items/other-soup").update({ isAvailable: false }));
  await assertFails(db.doc("items/main-soup").update({ priceMinor: -1 }));
  assert.equal((await db.doc("items/main-soup").get()).data()?.isAvailable, false);
});
