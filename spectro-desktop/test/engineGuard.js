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
//   6    the same hook carries a filter list — the adblock (card 201 AC 5)
//   7    capturePage() returns real PNG bytes
//
// It drives the SHIPPED modules (dist/browserFence.js, dist/adblock.js), not a
// copy of them, so a change to the fence changes what this proves.
//
// BITE — a check that is green in both directions pins nothing. Each mechanism
// has a switch that removes it, and the run is expected to go RED when one is
// set. Documented rather than done by hand-editing:
//
//   GUARD_BREAK=fence      the request hook stops judging addresses
//   GUARD_BREAK=adblock    the filter list is emptied
//   GUARD_BREAK=settle     the screenshot is taken before the pane has painted
//   GUARD_BREAK=pagectx    the eval is sent to an isolated world
//   GUARD_BREAK=await      the eval stops awaiting the returned Promise
//
// Run: npm run guard   (in spectro-desktop)

const { app, BaseWindow, WebContentsView, session } = require("electron");
const http = require("node:http");
const path = require("node:path");
const { refuse } = require(path.join(__dirname, "..", "dist", "browserFence.js"));
const { compileFilters, DEFAULT_FILTERS } = require(path.join(__dirname, "..", "dist", "adblock.js"));

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
      if (req.url === "/ads/banner.js") {
        res.writeHead(200, { "Content-Type": "application/javascript" });
        res.end("window.__ADS_LOADED__ = true;");
      } else if (req.url === "/app.js") {
        res.writeHead(200, { "Content-Type": "application/javascript" });
        res.end("window.__APP_LOADED__ = true;");
      } else {
        res.writeHead(200, { "Content-Type": "text/html" });
        res.end(`<!doctype html><html><head><title>guard fixture</title>
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
  ses.webRequest.onBeforeRequest((details, callback) => {
    const isTop = details.resourceType === "mainFrame";
    // allowLocalhost is on: the fixture IS loopback, which is the verify loop
    // the opt-in exists for.
    const verdict = BREAK === "fence" ? null : refuse(details.url, { allowLocalhost: true });
    if (verdict) {
      blocked.push({ url: verdict.address, kind: "fence" });
      return callback({ cancel: true });
    }
    if (filters.blocks(details.url, details.referrer || "", isTop)) {
      blocked.push({ url: details.url, kind: "adblock" });
      return callback({ cancel: true });
    }
    callback({});
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
