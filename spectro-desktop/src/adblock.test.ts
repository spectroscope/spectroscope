// The filter list, tested without a browser.
//
// Card 201 acceptance criterion 5 is an either-outcome: filter-list blocking
// demonstrably strips ads, or the card says why the engine cannot. The engine
// can — it is the same session.webRequest.onBeforeRequest hook the fence rides —
// so this is the matching half, and adblockPane.guard.js is the live half.

import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { compileFilters, DEFAULT_FILTERS, type Blocklist } from "./adblock";

const list: Blocklist = compileFilters(DEFAULT_FILTERS);

describe("adblock", () => {
  it("blocks a domain-anchored rule on the domain and its subdomains", () => {
    const rules = compileFilters(["||doubleclick.net^"]);
    assert.ok(rules.blocks("https://doubleclick.net/pixel.gif", "https://news.example/"));
    assert.ok(rules.blocks("https://ad.doubleclick.net/x", "https://news.example/"));
    assert.ok(!rules.blocks("https://notdoubleclick.net/x", "https://news.example/"));
    assert.ok(!rules.blocks("https://example.com/", "https://news.example/"));
  });

  it("blocks a substring rule anywhere in the URL", () => {
    const rules = compileFilters(["/ads/"]);
    assert.ok(rules.blocks("https://news.example/ads/banner.js", "https://news.example/"));
    assert.ok(!rules.blocks("https://news.example/adsense-guide.html", "https://news.example/"));
  });

  it("honours an @@ exception over a matching block rule", () => {
    const rules = compileFilters(["||tracker.example^", "@@||tracker.example/allowed"]);
    assert.ok(rules.blocks("https://tracker.example/beacon", "https://a.example/"));
    assert.ok(!rules.blocks("https://tracker.example/allowed/thing.js", "https://a.example/"));
  });

  it("ignores comments, blank lines and cosmetic rules it cannot enforce", () => {
    const rules = compileFilters([
      "! a comment",
      "",
      "   ",
      "example.com##.ad-banner",
      "[Adblock Plus 2.0]",
      "||realrule.example^",
    ]);
    assert.equal(rules.size, 1);
    assert.ok(rules.blocks("https://realrule.example/x", "https://a.example/"));
  });

  it("never blocks the page the operator is looking at", () => {
    // A filter list is a heuristic and the top-level document is not a
    // subresource: a rule that matched the page itself would leave a blank
    // pane and no explanation.
    const rules = compileFilters(["||news.example^"]);
    assert.ok(!rules.blocks("https://news.example/article", "https://news.example/article", true));
    assert.ok(rules.blocks("https://news.example/ad.js", "https://other.example/", false));
  });

  it("ships a default list that covers the ad hosts a test page uses", () => {
    assert.ok(list.size >= 10, `the shipped list is thin: ${list.size}`);
    for (const url of [
      "https://doubleclick.net/ad",
      "https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js",
      "https://www.googletagmanager.com/gtm.js",
      "https://connect.facebook.net/en_US/fbevents.js",
      "https://example.test/ads/leaderboard.png",
      "https://example.test/banner-ad.gif",
    ]) {
      assert.ok(list.blocks(url, "https://example.test/"), `should be blocked: ${url}`);
    }
  });

  it("leaves ordinary page assets alone", () => {
    for (const url of [
      "https://example.test/app.js",
      "https://example.test/styles/main.css",
      "https://cdn.example.test/react.production.min.js",
      "http://127.0.0.1:5173/src/main.tsx",
    ]) {
      assert.ok(!list.blocks(url, "https://example.test/"), `should NOT be blocked: ${url}`);
    }
  });
});
