import { beforeEach, describe, expect, it } from "vitest";
import { forgetVenueCredentials, saveVenueCredentials, savedVenueCredentials } from "./venueCredentials";

describe("venue credentials", () => {
  beforeEach(() => forgetVenueCredentials());

  it("restores the code and PIN for the current browser session", () => {
    saveVenueCredentials("MY-CAFE", "123456");
    expect(savedVenueCredentials()).toEqual({ code: "my-cafe", pin: "123456" });
  });

  it("forgets both values on request", () => {
    saveVenueCredentials("my-cafe", "123456");
    forgetVenueCredentials();
    expect(savedVenueCredentials()).toEqual({ code: "", pin: "" });
  });
});
