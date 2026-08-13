// The engine drift guard (card 200, section 7 — "standing up that runner is
// part of card 201, not an afterthought").
//
// The browser pane rests on four assumptions about the Chromium inside the
// Electron we ship. None of them is checked by a type, and all four fail
// SILENTLY when a Chromium major moves under them: an eval would start
// returning an opaque handle, a redirect would stop being judged, a screenshot
// would come back empty. So they are asserted against the shipped Electron,
// here, with a fixture server on loopback and nothing on the network.
//
//   1-4  the four pinned eval semantics (card 201 AC 3)
//   5    session.webRequest.onBeforeRequest fires for a REDIRECT hop — the fence
//   5b   …including an IPv4-mapped IPv6 literal, which the hook used to allow
//   5c   …and a host NAME that resolves privately, which it used to skip
//   6    the same hook carries a filter list — the adblock (card 201 AC 5)
//   7    capturePage() returns real PNG bytes
//   8    browser_resize really emulates a device: metrics, touch, user agent
//   9    two sessions' browsers share NOTHING — the card-218 isolation, measured
//        in the shipped Chromium rather than asserted about a string
//
// It drives the SHIPPED modules (dist/browserFence.js, dist/adblock.js,
// dist/deviceEmulation.js), not a copy of them, so a change to the fence or the
// emulation changes what this proves.
//
// BITE — a check that is green in both directions pins nothing. Each mechanism
// has a switch that removes it, and the run is expected to go RED when one is
// set. Documented rather than done by hand-editing:
//
//   GUARD_BREAK=fence      the request hook stops judging addresses
//   GUARD_BREAK=resolve    the hook stops resolving host names (the measured hole)
//   GUARD_BREAK=adblock    the filter list is emptied
//   GUARD_BREAK=settle     the screenshot is taken before the pane has painted
//   GUARD_BREAK=pagectx    the eval is sent to an isolated world
//   GUARD_BREAK=await      the eval stops awaiting the returned Promise
//   GUARD_BREAK=emulate    the viewport is not emulated at all (all three resize checks)
//   GUARD_BREAK=partition  both sessions get ONE partition (card 201's shape)
//
// Run: npm run guard   (in spectro-desktop)

const { app, BaseWindow, WebContentsView, session } = require("electron");
const http = require("node:http");
const path = require("node:path");
const { refuse, refuseResolved, cachedLookup } = require(path.join(__dirname, "..", "dist", "browserFence.js"));
const { compileFilters, DEFAULT_FILTERS } = require(path.join(__dirname, "..", "dist", "adblock.js"));
const { applyViewport } = require(path.join(__dirname, "..", "dist", "deviceEmulation.js"));
// The SHIPPED partition function, so a change to how a session is keyed changes
// what this proves. Requiring browserPane.js here is deliberate: the isolation
// must be the one the product uses, not one this file invents.
const { partitionFor } = require(path.join(__dirname, "..", "dist", "browserPane.js"));

// The resolver seam, answered from a table exactly the way NetFence.Resolver is
// in the Java suite. A guard that needed real DNS would be a guard that is red
// on a train, and what is under test here is not the resolver — it is whether
// an ASYNC verdict really cancels a load in this Chromium.
const NAMES = { "private.test": ["192.168.1.1"], "public.test": ["93.184.216.34"] };
const lookup = cachedLookup(async (host) => {
  if (!NAMES[host]) throw new Error("ENOTFOUND " + host);
  return NAMES[host];
});

const BREAK = process.env.GUARD_BREAK || "";
const filters = compileFilters(BREAK === "adblock" ? [] : DEFAULT_FILTERS);
const blocked = [];
const checks = [];

function record(name, pass, detail) {
  checks.push({ name, pass });
  console.log(`${pass ? "PASS" : "FAIL"}  ${name}${detail ? " — " + detail : ""}`);
}

// A fixture on loopback. Nothing here reaches the network, and no address in
// this file belongs to anybody: 192.168.1.1 is a stand-in from the curated list
// NoOperatorAddressesInTheRepoTest keeps, because this repository is public.
function startFixture() {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      if (req.url === "/redirect-to-private") {
        res.writeHead(302, { Location: "http://192.168.1.1/admin" });
        res.end();
        return;
      }
      // The reviewer's vector B: the same address in its IPv4-mapped IPv6
      // spelling, which used to fall through ruleForV6 to allowed and produce
      // ERR_CONNECTION_TIMED_OUT — the packet had left for the LAN.
      if (req.url === "/redirect-to-mapped") {
        res.writeHead(302, { Location: "http://[::ffff:192.168.1.1]/secret" });
        res.end();
        return;
      }
      // The reviewer's vector D: a NAME that resolves privately. Java refuses
      // it at the entry; nothing refused it on a hop.
      if (req.url === "/redirect-to-name") {
        res.writeHead(302, { Location: "http://private.test/secret" });
        res.end();
        return;
      }
      if (req.url === "/ads/banner.js") {
        res.writeHead(200, { "Content-Type": "application/javascript" });
        res.end("window.__ADS_LOADED__ = true;");
      } else if (req.url === "/app.js") {
        res.writeHead(200, { "Content-Type": "application/javascript" });
        res.end("window.__APP_LOADED__ = true;");
      } else {
        res.writeHead(200, { "Content-Type": "text/html" });
        res.end(`<!doctype html><html><head><title>guard fixture</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<script>window.__PAGE_MARKER__ = "page-context-ok";</script>
<script src="/ads/banner.js"></script>
<script src="/app.js"></script>
</head><body style="background:#101010;color:#eee;font:16px sans-serif">
<h1 id="head">card 201 fixture</h1>
<button id="go" onclick="document.getElementById('head').textContent='clicked'">go</button>
<input id="field" />
<div id="late"></div>
<script>setTimeout(() => { document.getElementById('late').textContent = 'LATE CONTENT'; }, 400);</script>
</body></html>`);
      }
    });
    server.listen(0, "127.0.0.1", () => resolve({ server, port: server.address().port }));
  });
}

async function main() {
  const { server, port } = await startFixture();
  const base = `http://127.0.0.1:${port}`;

  const ses = session.fromPartition("persist:spectro-guard");
  // The hook answers ASYNCHRONOUSLY, exactly as browserPane.ts does, because a
  // name has to be resolved before a hop can be judged. That the load is still
  // cancelled is itself one of the assumptions this guard exists to hold.
  ses.webRequest.onBeforeRequest((details, callback) => {
    const isTop = details.resourceType === "mainFrame";
    // allowLocalhost is on: the fixture IS loopback, which is the verify loop
    // the opt-in exists for.
    const policy = { allowLocalhost: true };
    void (async () => {
      let verdict = null;
      if (BREAK !== "fence") {
        verdict = BREAK === "resolve"
          ? refuse(details.url, policy)
          : await refuseResolved(details.url, policy, lookup);
      }
      if (verdict) {
        blocked.push({ url: verdict.address, rule: verdict.rule, kind: "fence" });
        return callback({ cancel: true });
      }
      if (filters.blocks(details.url, details.referrer || "", isTop)) {
        blocked.push({ url: details.url, kind: "adblock" });
        return callback({ cancel: true });
      }
      callback({});
    })();
  });

  const win = new BaseWindow({ width: 1000, height: 700, title: "spectro engine guard" });
  const view = new WebContentsView({ webPreferences: { session: ses, sandbox: true } });
  win.contentView.addChildView(view);
  view.setBounds({ x: 0, y: 0, width: 1000, height: 700 });
  const wc = view.webContents;

  await wc.loadURL(base + "/");
  record("navigate: a real visible pane loads the page", wc.getURL() === base + "/", wc.getURL());

  // 1. page context. The broken variant runs in an ISOLATED world: same DOM,
  //    no page globals — the failure a "close enough" eval ships with.
  const marker =
    BREAK === "pagectx"
      ? await wc.executeJavaScriptInIsolatedWorld(931, [{ code: "window.__PAGE_MARKER__" }])
      : await wc.executeJavaScript("window.__PAGE_MARKER__");
  record("eval 1/4: runs in the PAGE context", marker === "page-context-ok", JSON.stringify(marker));

  // 2. actuator AND sensor in one call: click, write through the native setter
  //    plus a dispatched event (the React-shaped input), then read back.
  const verdict = await wc.executeJavaScript(`(() => {
    document.getElementById('go').click();
    const field = document.getElementById('field');
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    setter.call(field, 'typed by eval');
    field.dispatchEvent(new Event('input', { bubbles: true }));
    return { heading: document.getElementById('head').textContent, value: field.value };
  })()`);
  record(
    "eval 2/4: acts AND senses in one call",
    verdict && verdict.heading === "clicked" && verdict.value === "typed by eval",
    JSON.stringify(verdict),
  );

  // 3. a returned Promise is awaited, not stringified into an opaque handle.
  const awaited =
    BREAK === "await"
      ? await wc.executeJavaScript("String(new Promise(r => setTimeout(() => r(41 + 1), 50)))")
      : await wc.executeJavaScript("new Promise(r => setTimeout(() => r(41 + 1), 50))");
  record("eval 3/4: a returned Promise is awaited", awaited === 42, JSON.stringify(awaited));

  // 4. the resolved value comes back structured, not as a handle or a string.
  const structured = await wc.executeJavaScript("({ ok: true, list: [1, 2], nested: { n: 3 } })");
  record(
    "eval 4/4: the resolved value is returned structured",
    structured && structured.ok === true && structured.nested.n === 3,
    JSON.stringify(structured),
  );

  // 5. the fence sees a REDIRECT hop. This is the concrete case the entry check
  //    cannot see: loopback is allowed, the server answers 302 -> a private
  //    address, and only the hook judges the second leg.
  blocked.length = 0;
  await wc.loadURL(base + "/redirect-to-private").catch(() => {
    // ERR_BLOCKED_BY_CLIENT rejects loadURL, which is itself the evidence.
  });
  const fenced = blocked.find((b) => b.kind === "fence" && String(b.url).includes("192.168.1.1"));
  record("fence: the private hop of a redirect is refused", Boolean(fenced), JSON.stringify(fenced || blocked));

  // 5b. the same address in its IPv4-mapped IPv6 spelling. Measured in review on
  //     2026-08-13: ERR_CONNECTION_TIMED_OUT and ZERO refusals, which means the
  //     packet left for the LAN while the plain literal was blocked.
  blocked.length = 0;
  await wc.loadURL(base + "/redirect-to-mapped").catch(() => {});
  const mapped = blocked.find((b) => b.kind === "fence" && b.rule === "rfc1918");
  record("fence: [::ffff:192.168.1.1] is read as the address it is", Boolean(mapped),
    JSON.stringify(mapped || blocked));

  // 5c. a host NAME that resolves privately. The hook used to skip DNS entirely,
  //     so a 302 to a public name pointing at a private address walked through.
  blocked.length = 0;
  await wc.loadURL(base + "/redirect-to-name").catch(() => {});
  const named = blocked.find((b) => b.kind === "fence" && String(b.url).includes("private.test"));
  record("fence: a hop to a name that resolves privately is refused", Boolean(named),
    JSON.stringify(named || blocked));

  // 6. the same hook carries a filter list. AC 5 is an either-outcome and this
  //    is the "it works" half: the ad script never runs, the app script does.
  blocked.length = 0;
  await wc.loadURL(base + "/");
  const adState = await wc.executeJavaScript(
    "({ ads: typeof window.__ADS_LOADED__, app: typeof window.__APP_LOADED__ })",
  );
  const adBlocked = blocked.some((b) => b.kind === "adblock");
  record(
    "adblock: the ad script is stripped and the page's own script is not",
    adState.ads === "undefined" && adState.app === "boolean" && adBlocked,
    JSON.stringify(adState) + " blocked=" + JSON.stringify(blocked.map((b) => b.kind)),
  );

  // 7. capturePage returns real PNG bytes. The spike measured that it THROWS
  //    when the pane has not painted (UnknownVizError, not an empty image), so
  //    the settle is part of the mechanism rather than politeness.
  if (BREAK !== "settle") {
    await new Promise((r) => setTimeout(r, 600));
  }
  let png = null;
  try {
    png = (await wc.capturePage()).toPNG();
  } catch (error) {
    png = null;
  }
  const isPng = png !== null && png.length > 1000 && png[0] === 0x89 && png[1] === 0x50;
  record("screenshot: capturePage returns PNG bytes above a floor", isPng, png ? png.length + " bytes" : "threw");
  const late = png !== null && (await wc.executeJavaScript("document.getElementById('late').textContent"));
  record("screenshot: the pane had painted its late content first", late === "LATE CONTENT", String(late));

  // 8. the viewport is EMULATED, not reported. The first version wrote a global
  //    nothing read and called setBounds, which the layout overwrote; measured
  //    after preset=mobile: innerWidth 800, maxTouchPoints 0, a Macintosh agent.
  await wc.loadURL(base + "/");
  if (BREAK !== "emulate") {
    await applyViewport(wc, 375, 812);
  }
  const phone = await wc.executeJavaScript(
    "({ w: window.innerWidth, h: window.innerHeight, sw: window.screen.width,"
    + " sh: window.screen.height, touch: navigator.maxTouchPoints,"
    + " coarse: window.matchMedia('(pointer: coarse)').matches })",
  );
  // The fixture declares a viewport meta tag, so the layout viewport and the
  // device agree. Without one Chromium lays out at the legacy 980 CSS pixels —
  // measured, real phone behaviour, and what the tool's sentence reports.
  record(
    "resize: the PAGE measures the viewport it was given",
    phone.sw === 375 && phone.sh === 812 && phone.w === 375,
    JSON.stringify(phone),
  );
  record(
    "resize: touch emulation reaches the page, and a coarse pointer with it",
    phone.touch >= 5 && phone.coarse === true,
    JSON.stringify(phone),
  );
  await wc.loadURL(base + "/");
  const agent = await wc.executeJavaScript("navigator.userAgent");
  record(
    "resize: a mobile user agent is in place on the next load",
    / Mobile /.test(agent),
    String(agent).slice(0, 80),
  );

  // 9. two sessions, two browsers, nothing shared (card 218). The isolation is
  //    Chromium's own — one Electron session per spectroscope session — and this
  //    is where that claim stops being a sentence about a string. A page logs in
  //    under session A; session B loads the SAME origin and finds nothing.
  const sessionA = "20260813-120000-aaaaaaaa";
  const sessionB = "20260813-130000-bbbbbbbb";
  const partA = partitionFor(BREAK === "partition" ? "shared" : sessionA);
  const partB = partitionFor(BREAK === "partition" ? "shared" : sessionB);
  const viewA = new WebContentsView({
    webPreferences: { session: session.fromPartition(partA), sandbox: true },
  });
  const viewB = new WebContentsView({
    webPreferences: { session: session.fromPartition(partB), sandbox: true },
  });
  win.contentView.addChildView(viewA);
  viewA.setBounds({ x: 0, y: 0, width: 500, height: 700 });
  win.contentView.addChildView(viewB);
  viewB.setBounds({ x: 500, y: 0, width: 500, height: 700 });

  await viewA.webContents.loadURL(base + "/");
  await viewA.webContents.executeJavaScript(`(() => {
    document.cookie = "spectro_login=secret-of-A; path=/";
    localStorage.setItem("spectro_token", "token-of-A");
    return true;
  })()`);
  // A reload first, so what B is asked about is a login that really persisted
  // rather than one line of script that happened to run a moment ago.
  await viewA.webContents.loadURL(base + "/");
  const inA = await viewA.webContents.executeJavaScript(
    "({ cookie: document.cookie, token: localStorage.getItem('spectro_token') })",
  );
  record(
    "isolation: a login persists inside the session that made it",
    inA.cookie.includes("secret-of-A") && inA.token === "token-of-A",
    JSON.stringify(inA),
  );

  await viewB.webContents.loadURL(base + "/");
  const inB = await viewB.webContents.executeJavaScript(
    "({ cookie: document.cookie, token: localStorage.getItem('spectro_token') })",
  );
  record(
    "isolation: the other session's browser sees neither cookie nor localStorage",
    !inB.cookie.includes("secret-of-A") && inB.token === null,
    `partitions ${partA} | ${partB} → ` + JSON.stringify(inB),
  );

  // And the same question asked of the engine rather than of the page, because a
  // cookie can be absent from document.cookie for reasons that are not isolation.
  const jarA = await session.fromPartition(partA).cookies.get({ name: "spectro_login" });
  const jarB = await session.fromPartition(partB).cookies.get({ name: "spectro_login" });
  record(
    "isolation: the cookie jar itself belongs to one session",
    jarA.length === 1 && jarB.length === 0,
    `A has ${jarA.length}, B has ${jarB.length}`,
  );

  server.close();
  const failed = checks.filter((c) => !c.pass);
  console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`
    + (BREAK ? `  (GUARD_BREAK=${BREAK} — failures here are the PROOF)` : ""));
  app.exit(failed.length === 0 ? 0 : 1);
}

app.whenReady().then(() =>
  main().catch((error) => {
    console.error("guard crashed:", error);
    app.exit(2);
  }),
);
