// The three pure functions the settings room stands on (card 357): the second
// reading of a value, the filter, and the grouping.
//
// The subjects here are hand-built entries and not the real registry, on
// purpose — these are properties of the FUNCTIONS, and feeding them the real
// list would make a green run depend on which constants happen to exist today.
// The claim that the room draws the real registry is next door, in
// governingNumbers.drift.test.tsx, where it belongs.

import { describe, expect, it } from "vitest";
import {
  GOVERNING_KINDS,
  filterGoverningNumbers,
  governs,
  groupGoverningNumbers,
  ownerSimpleName,
  readableValue,
  type GoverningKind,
  type GoverningNumber,
  type GoverningUnit,
} from "./governingNumbers";

function number(over: Partial<GoverningNumber> & { value: string; unit: GoverningUnit }): GoverningNumber {
  return {
    owner: "dev.spectroscope.core.Example",
    field: "A_LIMIT",
    expression: over.value,
    kind: "FIXED" as GoverningKind,
    key: "",
    explanation: "what it bounds.",
    ...over,
  };
}

describe("a value gets a second reading only where the decimal is unreadable", () => {
  it("says the byte sizes as a person would", () => {
    expect(readableValue(number({ value: "67108864", unit: "BYTES" }))).toBe("64 MiB");
    expect(readableValue(number({ value: "524288", unit: "BYTES" }))).toBe("512 KiB");
    expect(readableValue(number({ value: "1073741824", unit: "BYTES" }))).toBe("1 GiB");
  });

  it("says the long clocks in minutes and the short ones in seconds", () => {
    expect(readableValue(number({ value: "1800000", unit: "MILLISECONDS" }))).toBe("30 min");
    expect(readableValue(number({ value: "3000", unit: "MILLISECONDS" }))).toBe("3 s");
    expect(readableValue(number({ value: "600", unit: "SECONDS" }))).toBe("10 min");
  });

  it("stays silent when the plain number already says it", () => {
    // A parenthesis that repeats the number beside it is noise, and this page
    // is 110 rows long.
    expect(readableValue(number({ value: "150", unit: "TURNS" }))).toBeNull();
    expect(readableValue(number({ value: "50000", unit: "BYTES" }))).toBeNull();
    expect(readableValue(number({ value: "150", unit: "MILLISECONDS" }))).toBeNull();
    expect(readableValue(number({ value: "25", unit: "SECONDS" }))).toBeNull();
    expect(readableValue(number({ value: "0.85", unit: "RATIO" }))).toBeNull();
  });
});

describe("the filter answers the words an operator actually has", () => {
  const rows = [
    number({ value: "10", unit: "SECONDS", field: "COMMAND_TIMEOUT", key: "commandTimeoutSeconds" }),
    number({
      value: "4",
      unit: "COUNT",
      field: "PARALLEL_CHILDREN",
      explanation: "nobody has measured whether four is useful.",
    }),
  ];

  it("matches the reason, not only the identifier", () => {
    // Somebody who hit a limit is searching for the words of the message, not
    // for a Java name they have never seen.
    expect(filterGoverningNumbers(rows, "nobody has measured").map((n) => n.field)).toEqual([
      "PARALLEL_CHILDREN",
    ]);
  });

  it("matches the settings key and the constant, case-blind", () => {
    expect(filterGoverningNumbers(rows, "commandtimeoutseconds")).toHaveLength(1);
    expect(filterGoverningNumbers(rows, "parallel_children")).toHaveLength(1);
  });

  it("shows everything for a blank query and nothing for a miss", () => {
    expect(filterGoverningNumbers(rows, "   ")).toHaveLength(2);
    expect(filterGoverningNumbers(rows, "kubernetes")).toHaveLength(0);
  });
});

describe("the grouping is derived from the data", () => {
  it("draws a group for every kind in use and none for a kind that is not", () => {
    const rows = [
      number({ value: "1", unit: "COUNT", kind: "UNEXAMINED" }),
      number({ value: "2", unit: "COUNT", kind: "FIXED", field: "B_LIMIT" }),
      number({ value: "3", unit: "COUNT", kind: "UNEXAMINED", field: "C_LIMIT" }),
    ];
    const groups = groupGoverningNumbers(rows);
    expect(groups.map((g) => g.kind)).toEqual(["UNEXAMINED", "FIXED"]);
    expect(groups.map((g) => g.numbers.length)).toEqual([2, 1]);
  });

  it("keeps the vocabulary's order, not the registry's", () => {
    // The room reads top to bottom: what you can change, then what only looks
    // changeable, then the open questions. A registry sorted by class name
    // must not be able to reorder that.
    const rows = GOVERNING_KINDS.map((kind, at) =>
      number({ value: String(at), unit: "COUNT", kind, field: `F${at}` }),
    );
    expect(groupGoverningNumbers([...rows].reverse()).map((g) => g.kind)).toEqual([...GOVERNING_KINDS]);
  });

  it("loses nothing", () => {
    const rows = GOVERNING_KINDS.map((kind, at) =>
      number({ value: String(at), unit: "COUNT", kind, field: `F${at}` }),
    );
    expect(groupGoverningNumbers(rows).flatMap((g) => g.numbers)).toHaveLength(rows.length);
  });
});

describe("the small helpers", () => {
  it("shortens a class name to what a heading can carry", () => {
    expect(ownerSimpleName("dev.spectroscope.core.subagents.ChildBudget")).toBe("ChildBudget");
    expect(ownerSimpleName("Bare")).toBe("Bare");
  });

  it("calls the aliases and the plumbing not governing, and everything else governing", () => {
    expect(governs("ALIAS")).toBe(false);
    expect(governs("PLUMBING")).toBe(false);
    expect(GOVERNING_KINDS.filter(governs)).toHaveLength(GOVERNING_KINDS.length - 2);
  });
});
