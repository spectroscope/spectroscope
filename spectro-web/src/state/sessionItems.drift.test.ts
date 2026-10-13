// Card 587, fix round (M7): the sources a session_items row may name are the
// server's own list, read off disk here. SessionCatalogue.SOURCES is the closed
// list a layer of the catalogue must come from; a fifth source there turns
// this red until parseSessionItems reads it too, instead of dropping its rows.

import { describe, expect, it } from "vitest";
import { ITEM_SOURCES } from "./sessionItems";
import { read } from "../testkit/source";

const CATALOGUE = "../../../spectro-core/src/main/java/dev/spectroscope/core/skills/SessionCatalogue.java";

/** The server's source words, in the order SOURCES lists them. */
function serverSources(): string[] {
  const java = read(CATALOGUE, import.meta.url);
  const words = new Map(
    [...java.matchAll(/public static final String (\w+) = "([^"]+)";/g)].map((m) => [m[1] ?? "", m[2] ?? ""]),
  );
  const list = /public static final List<String> SOURCES = List\.of\(([^)]*)\);/.exec(java);
  expect(list, "SessionCatalogue declares SOURCES").not.toBeNull();
  return (list?.[1] ?? "").split(",").map((name) => {
    const word = words.get(name.trim());
    expect(word, `SOURCES names ${name.trim()}, a constant of the class`).toBeDefined();
    return word ?? "";
  });
}

describe("the session item sources against the server's list", () => {
  it("reads the server's list", () => {
    expect(serverSources().length).toBeGreaterThan(3);
  });

  it("reads every source the server sends, in the server's order", () => {
    expect([...ITEM_SOURCES]).toEqual(serverSources());
  });
});
