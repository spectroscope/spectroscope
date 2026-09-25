// Card 431: the loading sign of an open, the pure half. A later navigation
// takes an earlier open's sign down (criterion 5), and the sign names the
// session the way its row does (criterion 1).

import { describe, expect, it } from "vitest";
import { createNavNonce } from "./appRouter";
import {
  openingAfterIssue,
  rememberSessionTitles,
  sessionTitleOf,
  type SessionOpening,
} from "./sessionOpening";

const sign = (ticket: number): SessionOpening => ({
  ticket,
  sessionId: `s${ticket}`,
  title: `prompt ${ticket}`,
});

describe("a navigation ticket tells whoever listens", () => {
  it("hands every new ticket to the listener, after it is current", () => {
    const told: Array<[number, boolean]> = [];
    const nonce = createNavNonce((ticket) => told.push([ticket, nonce.isCurrent(ticket)]));
    const a = nonce.issue();
    const b = nonce.issue();
    expect([a, b]).toEqual([1, 2]);
    expect(told).toEqual([
      [1, true],
      [2, true],
    ]);
  });

  it("still works with no listener, as the skills nonce uses it", () => {
    const nonce = createNavNonce();
    const a = nonce.issue();
    expect(nonce.isCurrent(a)).toBe(true);
    nonce.issue();
    expect(nonce.isCurrent(a)).toBe(false);
  });
});

describe("a newer ticket takes an older open's sign down", () => {
  it("clears the sign of an open the new ticket superseded", () => {
    expect(openingAfterIssue(sign(1), 2)).toBeNull();
  });

  it("keeps the sign of the open that holds the ticket", () => {
    const own = sign(2);
    expect(openingAfterIssue(own, 2)).toBe(own);
  });

  it("has nothing to clear when no sign is up", () => {
    expect(openingAfterIssue(null, 3)).toBeNull();
  });

  it("clears the old sign when the listener runs before the new open raises its own", () => {
    // openSession issues its ticket, and the listener fires inside issue(),
    // before the open's own setOpening. Replayed in that order on one value,
    // the end state is the new sign and only the new sign.
    let shown: SessionOpening | null = sign(1);
    const nonce = createNavNonce((ticket) => {
      shown = openingAfterIssue(shown, ticket);
    });
    nonce.issue(); // ticket 1 belongs to the open already on screen
    shown = sign(1);
    const ticket = nonce.issue();
    expect(shown).toBeNull();
    shown = sign(ticket);
    expect(shown).toEqual(sign(2));
  });
});

describe("the sign names the session as its row does", () => {
  it("answers the first prompt the list carried for that id", () => {
    rememberSessionTitles([
      { id: "a", firstPrompt: "fix the build" },
      { id: "b", firstPrompt: "" },
    ]);
    expect(sessionTitleOf("a")).toBe("fix the build");
    // An empty prompt is a known row with no words, not an unknown row.
    expect(sessionTitleOf("b")).toBe("");
    expect(sessionTitleOf("c")).toBeNull();
  });

  it("names a row with a title by its title, as the row does since card 445", () => {
    rememberSessionTitles([
      { id: "a", firstPrompt: "hallo, kannst du mal", title: "Release 0.14.0" },
      { id: "b", firstPrompt: "fix the build", title: "  " },
    ]);
    expect(sessionTitleOf("a")).toBe("Release 0.14.0");
    expect(sessionTitleOf("b")).toBe("fix the build");
  });

  it("forgets a row the next list no longer carries", () => {
    rememberSessionTitles([{ id: "a", firstPrompt: "fix the build" }]);
    rememberSessionTitles([{ id: "b", firstPrompt: "write the card" }]);
    expect(sessionTitleOf("a")).toBeNull();
    expect(sessionTitleOf("b")).toBe("write the card");
  });
});
