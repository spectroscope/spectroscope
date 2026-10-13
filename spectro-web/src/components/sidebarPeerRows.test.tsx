// Card 503, criterion 8: the rail's session rows show the folder and the
// status line the live set carries, and a session of another process on this
// machine is listed with its face.

import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it } from "vitest";
import type { RunEvent } from "../events";
import { __getPeerRoster, __resetForTests, liveLineOf, liveSessionsPushLive } from "../state/liveSessions";
import { PeerRoster } from "./PeerRoster";
import { SessionRow } from "./Sidebar";
import { rowParts, type Density } from "../state/density";

beforeEach(() => __resetForTests());

describe("the live line of a row", () => {
  it("reads the folder's last segment and the status line", () => {
    expect(
      liveLineOf({
        id: "s1",
        running: true,
        since: 1,
        folder: "/Users/x/ForgeDemo",
        statusLine: "running read_file",
      }),
    ).toBe("ForgeDemo · running read_file");
    expect(liveLineOf({ id: "s1", running: false, since: 1 })).toBeUndefined();
  });

  it("is drawn under a live session's name", () => {
    const html = renderToStaticMarkup(
      <SessionRow
        s={{ id: "20261011-090000-aaaaaaaa", startedAt: 1, firstPrompt: "hello", tokens: 0 }}
        parts={rowParts("normal")}
        lang="en"
        active={false}
        state="running"
        onSelect={() => {}}
        liveLine="ForgeDemo · running read_file"
      />,
    );
    expect(html).toContain("ForgeDemo · running read_file");
  });
});

describe("the sessions of other processes", () => {
  it("come from the peer_roster frame", () => {
    liveSessionsPushLive([
      {
        type: "peer_roster",
        sessions: [
          {
            id: "s9",
            running: true,
            since: 1,
            folder: "/w/ForgeDemo",
            name: "ForgeDemo-7f",
            statusLine: "working",
            face: "repl",
            pid: 4711,
          },
        ],
      } as unknown as RunEvent,
    ]);
    expect(__getPeerRoster().map((r) => [r.name, r.face])).toEqual([["ForgeDemo-7f", "repl"]]);
  });

  it("are listed with their face, folder and status line", () => {
    const html = renderToStaticMarkup(
      <PeerRoster
        lang="en"
        rows={[
          {
            id: "s9",
            running: true,
            since: 1,
            folder: "/w/ForgeDemo",
            name: "ForgeDemo-7f",
            statusLine: "working",
            face: "repl",
            pid: 4711,
          },
        ]}
        parts={rowParts("normal")}
      />,
    );
    expect(html).toContain("ForgeDemo-7f");
    expect(html).toContain("terminal");
    expect(html).toContain("ForgeDemo · working");
    expect(html).toContain('data-face="repl"');
    expect(renderToStaticMarkup(<PeerRoster lang="de" rows={[]} parts={rowParts("normal")} />)).toBe("");
  });
});

describe("the peer roster at each density (card 555)", () => {
  // The integrator's decision on the review: the rows of other processes follow
  // the same rowParts rule as the rail's own rows. A peer row has no dot, so at
  // minimal it is its name; normal and extended keep the face and the line.
  const PEER = {
    id: "s9",
    running: true,
    since: 1,
    folder: "/w/ForgeDemo",
    name: "ForgeDemo-7f",
    statusLine: "working",
    face: "repl",
    pid: 4711,
  };
  const rosterAt = (at: Density): string =>
    renderToStaticMarkup(<PeerRoster lang="en" rows={[PEER]} parts={rowParts(at)} />);
  const visible = (html: string): string =>
    html
      .replace(/<[^>]*>/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  const count = (hay: string, needle: string): number => hay.split(needle).length - 1;

  it("shows the name and nothing else at minimal", () => {
    const html = rosterAt("minimal");
    expect(visible(html)).toBe("Other sessions on this machine ForgeDemo-7f");
    expect(count(html, "peer-row-line")).toBe(0);
    expect(count(html, "peer-row-face")).toBe(0);
    expect(html).not.toContain("ForgeDemo · working");
    // Still one row: minimal cuts what a row says, not which rows there are.
    expect(count(html, 'class="peer-row"')).toBe(1);
  });

  it("keeps the face and the folder and state line at normal and extended", () => {
    for (const at of ["normal", "extended"] as const) {
      const html = rosterAt(at);
      expect(visible(html), at).toBe(
        "Other sessions on this machine ForgeDemo-7f · terminal ForgeDemo · working",
      );
      expect(count(html, 'class="peer-row-line"'), at).toBe(1);
      expect(count(html, 'class="peer-row-face"'), at).toBe(1);
    }
  });
});
