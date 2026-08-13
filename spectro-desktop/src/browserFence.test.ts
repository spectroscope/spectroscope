// The in-hook fence, tested without Electron.
//
// This is the half of card 199's fence that the Java NetFence cannot reach: it
// runs inside session.webRequest.onBeforeRequest, so it judges the top-level
// navigation, EVERY redirect hop and every subresource. The Java side judges
// the address the tool was handed; this side judges the journey.
//
// The vectors come from a table shared with the Java suite (fence-vectors.json)
// so the two halves cannot drift apart in silence.

import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { refuse, type FencePolicy } from "./browserFence";

const VECTOR_FILE = path.join(
  __dirname, "..", "..",
  "spectro-core", "src", "main", "resources", "browser", "fence-vectors.json",
);
const TABLE = JSON.parse(readFileSync(VECTOR_FILE, "utf8")) as {
  vectors: { url: string; rule: string | null; allowLocalhost: boolean }[];
  divergences: {
    url: string;
    allowLocalhost: boolean;
    java: string | null;
    hook: string | null;
    why: string;
  }[];
};
const VECTORS = TABLE.vectors;

const closed: FencePolicy = { allowLocalhost: false };
const opened: FencePolicy = { allowLocalhost: true };

describe("browserFence", () => {
  it("agrees with the shared vector table, vector by vector", () => {
    for (const v of VECTORS) {
      const verdict = refuse(v.url, v.allowLocalhost ? opened : closed);
      assert.equal(
        verdict === null ? null : verdict.rule,
        v.rule,
        `${v.url} (allowLocalhost=${v.allowLocalhost}) should be ${v.rule ?? "allowed"}`,
      );
    }
  });

  it("refuses a private hop reached through a redirect, which is the whole point", () => {
    // The tool was handed loopback and the Java fence let it through; the
    // server answered 302 -> 192.168.1.1. Only this hook sees that.
    const hop = refuse("http://192.168.1.1/admin", opened);
    assert.ok(hop);
    assert.equal(hop.rule, "rfc1918");
    assert.match(hop.sentence, /192\.168\.1\.1/);
  });

  it("names the address in every refusal and carries nothing else", () => {
    const verdict = refuse("http://10.0.0.5/x?token=SECRETVALUE#frag", closed);
    assert.ok(verdict);
    assert.match(verdict.sentence, /10\.0\.0\.5/);
    assert.ok(!verdict.sentence.includes("SECRETVALUE"), verdict.sentence);
    assert.ok(!verdict.sentence.includes("/x"), verdict.sentence);
  });

  it("keeps the loopback opt-in narrow: it never widens to the LAN or the tailnet", () => {
    assert.equal(refuse("http://127.0.0.1:5173/", opened), null);
    assert.equal(refuse("http://192.168.1.5/", opened)?.rule, "rfc1918");
    // A stand-in from the first addresses of the CGNAT block, never a real node:
    // this repository is public and a guard test enforces that.
    assert.equal(refuse("http://100.64.0.1:1234/", opened)?.rule, "cgnat-tailnet");
    assert.equal(refuse("file:///etc/passwd", opened)?.rule, "file-url");
  });

  it("reads an IPv4 address in the spellings a parser accepts, not only dotted quads", () => {
    // 2130706433 and 0x7f000001 are both 127.0.0.1. A fence that only knows
    // dotted quads hands the browser a loopback address it never judged.
    assert.equal(refuse("http://2130706433/", closed)?.rule, "loopback");
    assert.equal(refuse("http://0x7f000001/", closed)?.rule, "loopback");
    assert.equal(refuse("http://[::1]/", closed)?.rule, "loopback");
  });

  it("still answers the divergence register the way the register says it does", () => {
    // Where Java and this half honestly differ, the register says so and both
    // sides assert their own column — so a Chromium upgrade that changes host
    // parsing turns this red instead of quietly making the register fiction.
    assert.ok(TABLE.divergences.length >= 2);
    for (const row of TABLE.divergences) {
      const verdict = refuse(row.url, row.allowLocalhost ? opened : closed);
      assert.equal(
        verdict === null ? null : verdict.rule,
        row.hook,
        `${row.url}: the register says the hook answers ${row.hook ?? "allowed"} — ${row.why}`,
      );
    }
  });

  it("catches the octal loopback the Java entry check waves through", () => {
    // The measured find, and the reason the hook exists rather than only the
    // entry check: the JDK reads 0177.0.0.1 as the public 177.0.0.1 and allows
    // it. Chromium dials 127.0.0.1. Only the request hook sees that.
    const verdict = refuse("http://0177.0.0.1/", closed);
    assert.ok(verdict, "the hook must refuse what the browser will actually dial");
    assert.equal(verdict.rule, "loopback");
  });
});
