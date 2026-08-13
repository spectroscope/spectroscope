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
import {
  cachedLookup, refuse, refuseResolved, type FencePolicy, type HostLookup,
} from "./browserFence";

const VECTOR_FILE = path.join(
  __dirname, "..", "..",
  "spectro-core", "src", "main", "resources", "browser", "fence-vectors.json",
);
const TABLE = JSON.parse(readFileSync(VECTOR_FILE, "utf8")) as {
  vectors: { url: string; rule: string | null; allowLocalhost: boolean }[];
  names: {
    url: string;
    resolvesTo: string[];
    allowLocalhost: boolean;
    rule: string | null;
  }[];
  divergences: {
    url: string;
    allowLocalhost: boolean;
    java: string | null;
    hook: string | null;
    why: string;
  }[];
};
const VECTORS = TABLE.vectors;

/** A resolver that answers from the table and never touches the network. */
function answering(table: Record<string, string[]>): HostLookup {
  return async (host) => {
    const answers = table[host];
    if (!answers) throw new Error(`ENOTFOUND ${host}`);
    return answers;
  };
}

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

  it("reads an IPv4-mapped IPv6 literal as the IPv4 address it is", async () => {
    // The measured bypass: ruleForV6 tested ::1, fe8x, fcxx and ffxx and had no
    // ::ffff: case, so [::ffff:192.168.1.1] fell through to ALLOWED. A 302 to it
    // produced ERR_CONNECTION_TIMED_OUT with zero fence refusals — the packet
    // left for the LAN — while the plain literal produced ERR_BLOCKED_BY_CLIENT.
    // Chromium normalises the dotted spelling to hex, so both are checked.
    assert.equal(refuse("http://[::ffff:192.168.1.1]/secret", opened)?.rule, "rfc1918");
    assert.equal(refuse("http://[::ffff:c0a8:101]/secret", opened)?.rule, "rfc1918");
    assert.equal(refuse("http://[0:0:0:0:0:ffff:c0a8:101]/", opened)?.rule, "rfc1918");
    assert.equal(refuse("http://[::ffff:127.0.0.1]/", closed)?.rule, "loopback");
    assert.equal(refuse("http://[::FFFF:7F00:1]/", closed)?.rule, "loopback");
    assert.equal(refuse("http://[::ffff:169.254.169.254]/", opened)?.rule, "link-local");
    assert.equal(refuse("http://[::ffff:100.64.0.1]/", opened)?.rule, "cgnat-tailnet");
    // and the opt-in still governs the mapped spelling of loopback
    assert.equal(refuse("http://[::ffff:127.0.0.1]/", opened), null);

    // Chromium normalises the dotted spelling away, and nobody recognises
    // their own router in "::ffff:c0a8:101" — so the sentence carries both.
    const said = refuse("http://[::ffff:192.168.1.1]/secret", opened);
    assert.ok(said);
    assert.match(said.sentence, /::ffff:c0a8:101/, said.sentence);
    assert.match(said.sentence, /192\.168\.1\.1 in an IPv6 spelling/, said.sentence);
    assert.ok(!said.sentence.includes("/secret"), said.sentence);
  });

  it("still reads an ordinary IPv6 literal, in every spelling of it", () => {
    assert.equal(refuse("http://[0:0:0:0:0:0:0:1]/", closed)?.rule, "loopback");
    assert.equal(refuse("http://[::]/", opened)?.rule, "unspecified");
    // A zone id never survives the WHATWG parser, so the hook never sees one —
    // it is unreadable rather than allowed, which is the safe direction.
    assert.equal(refuse("http://[fe80::1%25en0]/", opened)?.rule, "unparsable");
    assert.equal(refuse("http://[febf::1]/", opened)?.rule, "link-local");
    assert.equal(refuse("http://[fd00::1]/", opened)?.rule, "unique-local");
    assert.equal(refuse("http://[ff02::1]/", opened)?.rule, "multicast");
    assert.equal(refuse("http://[2606:4700::1111]/", closed), null);
  });

  it("resolves a host NAME and refuses what it points at", async () => {
    // The second measured bypass: with allowLocalhost OFF, a 302 to a public
    // name that resolves to 127.0.0.1 loaded fine, title "PWNED", zero
    // refusals. Java catches it at the entry; nothing caught it on a hop.
    const dns = answering({
      "localtest.example": ["127.0.0.1"],
      "intranet.example.com": ["192.168.1.1"],
      "cdn.example.com": ["93.184.216.34"],
      "split.example.com": ["93.184.216.34", "10.0.0.5"],
    });
    const hop = await refuseResolved("http://localtest.example:8875/secret", closed, dns);
    assert.ok(hop, "a name that resolves to loopback is refused with the opt-in off");
    assert.equal(hop.rule, "loopback");
    assert.match(hop.sentence, /localtest\.example:8875/);
    assert.match(hop.sentence, /127\.0\.0\.1/, "and the sentence says what it resolved to");

    assert.equal(await refuseResolved("http://localtest.example:8875/", opened, dns), null);
    assert.equal(
      (await refuseResolved("http://intranet.example.com/", opened, dns))?.rule,
      "rfc1918",
    );
    assert.equal(await refuseResolved("http://cdn.example.com/", closed, dns), null);
    assert.equal(
      (await refuseResolved("http://split.example.com/", opened, dns))?.rule,
      "rfc1918",
      "one private answer among public ones still refuses",
    );
  });

  it("agrees with the shared table on names too, with the answers the table states", async () => {
    for (const v of TABLE.names) {
      const dns = answering({ [new URL(v.url).hostname]: v.resolvesTo });
      const verdict = await refuseResolved(v.url, v.allowLocalhost ? opened : closed, dns);
      assert.equal(
        verdict === null ? null : verdict.rule,
        v.rule,
        `${v.url} -> ${v.resolvesTo.join(", ")} should be ${v.rule ?? "allowed"}`,
      );
    }
  });

  it("invents no answer for a name DNS cannot resolve", async () => {
    const verdict = await refuseResolved(
      "http://nothing.invalid/", closed, answering({}),
    );
    assert.equal(verdict, null, "a request that cannot resolve cannot connect either");
  });

  it("does not send an address literal to the resolver at all", async () => {
    let asked = 0;
    const counting: HostLookup = async (host) => {
      asked += 1;
      return [host];
    };
    assert.equal((await refuseResolved("http://192.168.1.1/", opened, counting))?.rule, "rfc1918");
    assert.equal(await refuseResolved("https://93.184.216.34/", closed, counting), null);
    assert.equal(await refuseResolved("http://[2606:4700::1111]/", closed, counting), null);
    assert.equal(asked, 0, "a literal is already an answer");
  });

  it("reuses one answer per host for the cache window and then asks again", async () => {
    let asked = 0;
    let clock = 1_000;
    const lookup = cachedLookup(async () => {
      asked += 1;
      return ["93.184.216.34"];
    }, () => clock, 30_000);

    await lookup("cdn.example.com");
    await lookup("cdn.example.com");
    await lookup("cdn.example.com");
    assert.equal(asked, 1, "fifty subresources on one host are one lookup");

    clock += 30_001;
    await lookup("cdn.example.com");
    assert.equal(asked, 2, "and the window really does end");
  });

  it("forgets a failed lookup instead of caching the failure", async () => {
    let asked = 0;
    const lookup = cachedLookup(async () => {
      asked += 1;
      throw new Error("ENOTFOUND");
    }, () => 1_000, 30_000);
    await assert.rejects(lookup("flaky.example.com"));
    await assert.rejects(lookup("flaky.example.com"));
    assert.equal(asked, 2);
  });
});
