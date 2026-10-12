// Card 504, hub and spoke review round 2: two gear changes on a stored session
// before its resume has fetched. The second used to start a second resume,
// whose newer ticket made the first return with its frame dropped, while the
// gear had already moved on. A frame for the session a resume is fetching now
// joins that resume, and a later resume of the same session carries what the
// earlier one held.

import { describe, expect, it } from "vitest";
import type { ClientMessage } from "../events";
import { createNavNonce } from "./appRouter";
import { ResumeJoin } from "./resumeJoin";

const MODE: ClientMessage = { type: "set_permission_mode", mode: "auto" };
const GROUPS: ClientMessage = { type: "set_tool_groups_off", groups: ["web"], save: false };
const GOAL: ClientMessage = { type: "set_goal", outcome: "green", check: "npm test" };

/** What App's resumeSession does before its fetch: carry, issue, begin. */
function startResume(
  join: ResumeJoin,
  nonce: ReturnType<typeof createNavNonce>,
  id: string,
  frame?: ClientMessage,
) {
  const carried = join.carried(id);
  const ticket = nonce.issue();
  join.begin(id, ticket, frame === undefined ? carried : [...carried, frame]);
  return ticket;
}

describe("ResumeJoin", () => {
  it("a second frame before the fetch resolves joins the resume in flight", () => {
    const nonce = createNavNonce();
    const join = new ResumeJoin(nonce.isCurrent);
    const ticket = startResume(join, nonce, "A", MODE);

    expect(join.join("A", GROUPS), "the second gear change joins").toBe(true);
    expect(join.join("A", GOAL)).toBe(true);

    expect(nonce.isCurrent(ticket), "no new ticket was issued").toBe(true);
    expect(join.take(ticket)).toEqual([MODE, GROUPS, GOAL]);
    expect(join.take(ticket), "taken once").toEqual([]);
  });

  it("a text resume after a frame resume of the same session carries the frames", () => {
    const nonce = createNavNonce();
    const join = new ResumeJoin(nonce.isCurrent);
    const first = startResume(join, nonce, "A", MODE);
    const second = startResume(join, nonce, "A");

    expect(nonce.isCurrent(first), "the first resume returns without opening").toBe(false);
    expect(join.take(first)).toEqual([]);
    expect(join.take(second)).toEqual([MODE]);
  });

  it("a navigation in between drops the join, and the next frame starts its own resume", () => {
    const nonce = createNavNonce();
    const join = new ResumeJoin(nonce.isCurrent);
    startResume(join, nonce, "A", MODE);
    nonce.issue(); // another session opened

    expect(join.join("A", GROUPS)).toBe(false);
    expect(join.carried("A"), "a later resume of A does not send an abandoned frame").toEqual([]);
  });

  it("a frame for another session does not join", () => {
    const nonce = createNavNonce();
    const join = new ResumeJoin(nonce.isCurrent);
    const ticket = startResume(join, nonce, "A", MODE);

    expect(join.join("B", GROUPS)).toBe(false);
    expect(join.take(ticket)).toEqual([MODE]);
  });

  it("nothing joins when no resume is in flight", () => {
    const nonce = createNavNonce();
    const join = new ResumeJoin(nonce.isCurrent);
    expect(join.join("A", MODE)).toBe(false);
    expect(join.carried("A")).toEqual([]);
  });
});
