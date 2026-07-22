import { describe, it, expect } from "vitest";
import { KNOWN_ROLES, roleFieldOptions } from "./roleField";

describe("roleFieldOptions", () => {
  it("offers just the known roles for a known selection", () => {
    expect(roleFieldOptions("worker", false)).toEqual([...KNOWN_ROLES]);
  });
  it("treats empty as known — no prepend", () => {
    expect(roleFieldOptions("", false)).toEqual([...KNOWN_ROLES]);
  });
  it("prepends a seeded custom role so the select can display it", () => {
    expect(roleFieldOptions("reviewer-2", false)).toEqual(["reviewer-2", ...KNOWN_ROLES]);
  });
  it("shows only the known roles in custom-input mode (the text input carries the value)", () => {
    expect(roleFieldOptions("reviewer-2", true)).toEqual([...KNOWN_ROLES]);
  });
});
