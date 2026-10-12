// Card 503, criterion 8: the rail's session rows show the folder and the
// status line the live set carries, and a session of another process on this
// machine is listed with its face.

import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it } from "vitest";
import type { RunEvent } from "../events";
import { __getPeerRoster, __resetForTests, liveLineOf, liveSessionsPushLive } from "../state/liveSessions";
import { PeerRoster } from "./PeerRoster";
import { SessionRow } from "./Sidebar";
import { rowParts } from "../state/density";

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
      />,
    );
    expect(html).toContain("ForgeDemo-7f");
    expect(html).toContain("terminal");
    expect(html).toContain("ForgeDemo · working");
    expect(html).toContain('data-face="repl"');
    expect(renderToStaticMarkup(<PeerRoster lang="de" rows={[]} />)).toBe("");
  });
});
