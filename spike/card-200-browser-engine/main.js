// Card 200 — the browser engine PoC, on Electron's WebContentsView.
//
// What this has to prove, and why each one is here rather than argued:
//
//   navigate    a real VISIBLE pane inside the app window, not a headless dump
//   eval        the four pinned semantics from browser-eval-semantics.md
//   screenshot  PNG bytes out of the live pane, the input card 198's path wants
//   fence       EVERY request judged, redirects included — the hole browse_page
//               documents in its own javadoc and cannot close
//   adblock     a network-level block rule, on the same hook as the fence
//
// It is a spike. Nothing here is wired into the product build: this folder is
// outside settings.gradle and outside spectro-web. It runs on the Electron the
// desktop app ALREADY ships (43.3.0), which is the whole economic argument.
//
// Run: spike/card-200-browser-engine/run.sh

const { app, BaseWindow, WebContentsView, session } = require("electron");
const fs = require("fs");
const path = require("path");
const fixture = require("./fixture-server");

const PORT = 8771; // not 8746 (the board), not 8099 (the owner's server)
const OUT = path.join(__dirname, "out");

// ---------------------------------------------------------------------------
// The fence, as the browser's own request hook sees it.
//
// This is the part the Java NetFence javadoc says needs "a proxy Chrome runs
// through, and that is its own card". In Electron it is an in-process callback
// on the session: no listening socket, no second component, and it fires for
// the top-level navigation, every redirect hop AND every subresource.
// ---------------------------------------------------------------------------

const PRIVATE_V4 = [
  [/^10\./, "RFC-1918 10/8"],
  [/^172\.(1[6-9]|2\d|3[01])\./, "RFC-1918 172.16/12"],
  [/^192\.168\./, "RFC-1918 192.168/16"],
  [/^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./, "100.64/10 (tailnet)"],
  [/^169\.254\./, "link-local 169.254/16"],
];

/** Mirrors NetFence.refuse for the spike: null means allowed. */
function refuse(rawUrl, { allowLocalhost }) {
  let u;
  try {
    u = new URL(rawUrl);
  } catch {
    return "unreadable URL";
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") {
    return `scheme ${u.protocol} is refused`;
  }
  const host = u.hostname.replace(/^\[|\]$/g, "");
  if (host === "127.0.0.1" || host === "localhost" || host === "::1") {
    return allowLocalhost ? null : "loopback without the localhost opt-in";
  }
  for (const [re, rule] of PRIVATE_V4) {
    if (re.test(host)) return rule;
  }
  return null;
}

// A stand-in for a filter list. The real thing is a card; what matters here is
// only whether the hook can carry one at all.
const ADBLOCK = [/\/ads\//, /doubleclick\.net/, /googletagmanager\.com/];

// ---------------------------------------------------------------------------

// BITE — break it once, see red, restore, see green. A check that is green in
// both directions pins nothing, so each mechanism has a switch that removes it
// and the run is expected to go RED when one is set. Documented rather than
// done by hand-editing, so the next reader can re-run the proof:
//
//   SPIKE_BREAK=fence      the request hook stops judging addresses
//   SPIKE_BREAK=adblock    the filter list is emptied
//   SPIKE_BREAK=settle     the screenshot is taken before the late content
//   SPIKE_BREAK=pagectx    the eval is sent to the wrong world
const BREAK = process.env.SPIKE_BREAK || "";

const results = {
  engine: "electron-webcontentsview",
  electron: process.versions.electron,
  chrome: process.versions.chrome,
  broke: BREAK || null,
  checks: [],
};
const blocked = [];

function record(name, pass, detail) {
  results.checks.push({ name, pass, detail });
  console.log(`${pass ? "PASS" : "FAIL"}  ${name}${detail ? " — " + detail : ""}`);
}

async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  const server = await fixture.start(PORT);
  const base = `http://127.0.0.1:${PORT}`;

  const ses = session.fromPartition("persist:spike-200");

  ses.webRequest.onBeforeRequest((details, callback) => {
    // The fence, judging every hop. `allowLocalhost` is the explicit opt-in
    // the verify loop needs and card 199 already models.
    const why = BREAK === "fence" ? null : refuse(details.url, { allowLocalhost: true });
    if (why) {
      blocked.push({ url: details.url, reason: why, kind: "fence" });
      return callback({ cancel: true });
    }
    if (BREAK !== "adblock" && ADBLOCK.some((re) => re.test(details.url))) {
      blocked.push({ url: details.url, reason: "adblock rule", kind: "adblock" });
      return callback({ cancel: true });
    }
    callback({});
  });

  // A real window the owner can watch, with the page as a pane inside it —
  // this is the shape card 201 wants, not a separate browser process.
  const win = new BaseWindow({ width: 1100, height: 760, title: "spectro browser spike" });
  const view = new WebContentsView({ webPreferences: { session: ses, sandbox: true } });
  win.contentView.addChildView(view);
  view.setBounds({ x: 0, y: 0, width: 1100, height: 760 });
  const wc = view.webContents;

  // ---- 1. navigate ------------------------------------------------------
  const t0 = Date.now();
  await wc.loadURL(base + "/");
  const navMs = Date.now() - t0;
  record("navigate: loadURL resolves on a real visible pane", wc.getURL() === base + "/", `${navMs} ms, url=${wc.getURL()}`);

  // ---- 2. eval, semantic 1: page context --------------------------------
  // The broken variant runs in an ISOLATED world: same DOM, no page globals —
  // exactly the failure a "close enough" eval implementation ships.
  const marker =
    BREAK === "pagectx"
      ? await wc.executeJavaScriptInIsolatedWorld(999, [{ code: `window.__PAGE_MARKER__` }])
      : await wc.executeJavaScript(`window.__PAGE_MARKER__`);
  record("eval 1/4: runs in PAGE context (sees window.__PAGE_MARKER__)", marker === "page-context-ok", `got ${JSON.stringify(marker)}`);

  // ---- 3. eval, semantic 2: actuator AND sensor -------------------------
  // Click twice, then drive a React-shaped input via the native setter plus a
  // dispatched event, then read the page's reaction back. One call is both.
  const actuate = await wc.executeJavaScript(`
    (() => {
      const b = document.getElementById('counter');
      b.click(); b.click();
      const input = document.getElementById('field');
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
      setter.call(input, 'driven-by-eval');
      input.dispatchEvent(new Event('input', { bubbles: true }));
      return { button: b.textContent, echo: document.getElementById('echo').textContent };
    })()
  `);
  record(
    "eval 2/4: actuator and sensor (click + native setter + dispatchEvent)",
    actuate.button === "clicked 2 times" && actuate.echo === "echo:driven-by-eval",
    JSON.stringify(actuate)
  );

  // ---- 4. eval, semantic 3: Promises are awaited ------------------------
  const tp = Date.now();
  const awaited = await wc.executeJavaScript(`
    fetch('/slow.json').then(r => r.json()).then(j => j.slow + '-after-' + '250ms')
  `);
  record(
    "eval 3/4: a returned Promise is AWAITED, not stringified",
    awaited === "arrived-after-250ms",
    `${JSON.stringify(awaited)} in ${Date.now() - tp} ms`
  );

  // ---- 5. eval, semantic 4: JSON-serialized return ----------------------
  const shaped = await wc.executeJavaScript(`({ n: 42, list: [1,2,3], nested: { ok: true }, when: null })`);
  const shapeOk =
    shaped && shaped.n === 42 && Array.isArray(shaped.list) && shaped.list.length === 3 && shaped.nested.ok === true;
  record("eval 4/4: structured value returns JSON-serialized", shapeOk, JSON.stringify(shaped));

  // ---- 6. adblock -------------------------------------------------------
  const trackerRan = await wc.executeJavaScript(`window.__TRACKER_RAN__ === true`);
  const adHit = blocked.find((b) => b.kind === "adblock");
  record("adblock: /ads/tracker.js never executed", trackerRan === false && !!adHit, adHit ? `blocked ${adHit.url}` : "no block recorded");

  // ---- 7. the fence across a REDIRECT -----------------------------------
  // browse_page is judged at the address it is handed and no further; its own
  // javadoc says so. Here the handed address is loopback (allowed) and the 302
  // lands in RFC-1918 — the hop the entry check cannot see.
  let redirectRefused = false;
  try {
    await wc.loadURL(base + "/redirect-to-private");
  } catch (e) {
    redirectRefused = /ERR_BLOCKED_BY_CLIENT|ERR_ABORTED|ERR_FAILED/.test(String(e.message || e));
  }
  const fenceHit = blocked.find((b) => b.kind === "fence" && b.url.includes("192.168.1.1"));
  record(
    "fence: a 302 hop into RFC-1918 is refused mid-journey",
    !!fenceHit && redirectRefused,
    fenceHit ? `${fenceHit.url} — ${fenceHit.reason}` : "the private hop was NOT seen"
  );

  // ---- 8. screenshot ----------------------------------------------------
  await wc.loadURL(base + "/");
  if (BREAK !== "settle") await new Promise((r) => setTimeout(r, 600)); // let the late content land
  const ts = Date.now();
  // capturePage THROWS UnknownVizError when the pane has not painted yet — the
  // SPIKE_BREAK=settle run is how we know, and it is a requirement for card 201
  // rather than a curiosity: a screenshot action must wait for paint, and the
  // failure is an exception, not an empty image it could return by accident.
  let image = null;
  let captureError = null;
  try {
    image = await wc.capturePage();
  } catch (e) {
    captureError = String(e.message || e);
  }
  const png = image ? image.toPNG() : Buffer.alloc(0);
  const shotMs = Date.now() - ts;
  const file = path.join(OUT, "screenshot.png");
  if (png.length) fs.writeFileSync(file, png);
  const size = image ? image.getSize() : { width: 0, height: 0 };
  const isPng = png.length > 8 && png[0] === 0x89 && png[1] === 0x50 && png[2] === 0x4e && png[3] === 0x47;
  record(
    "screenshot: capturePage yields real PNG bytes from the live pane",
    isPng && png.length > 5000,
    captureError
      ? `capturePage threw: ${captureError}`
      : `${png.length} bytes, ${size.width}x${size.height}, ${shotMs} ms → ${file}`
  );

  // The screenshot has to be worth attaching: prove the late content is in it
  // rather than trusting the timing.
  const headingNow = await wc.executeJavaScript(`document.getElementById('heading').textContent`);
  record("screenshot: the pane had settled (late content present)", headingNow === "spike fixture ready", `heading=${JSON.stringify(headingNow)}`);

  // ---- 9. what it costs card 198 ---------------------------------------
  // MAX_IMAGE_BYTES is the providers' wire limit; a full-window PNG must fit.
  const CAP = 5 * 1024 * 1024;
  record("screenshot fits the MCP image cap without downscaling", png.length < CAP, `${png.length} of ${CAP} bytes`);

  // ---- 10. live frames (card 204's socket-only frames) -----------------
  // On the desktop face the pane is watched DIRECTLY, so frames are only
  // needed for replay and recording. Measured anyway, because card 204 wants
  // the same sidecar from whichever engine wins.
  let frames = 0;
  let frameBytes = 0;
  const castStart = Date.now();
  wc.beginFrameSubscription(false, (image) => {
    frames++;
    frameBytes += image.toJPEG(60).length;
  });
  for (let i = 0; i < 12; i++) {
    await wc.executeJavaScript(`document.getElementById('counter').click()`);
    await new Promise((r) => setTimeout(r, 120));
  }
  wc.endFrameSubscription();
  const castMs = Date.now() - castStart;
  record(
    "live frames: beginFrameSubscription emits a continuous stream",
    frames >= 3,
    `${frames} frames in ${castMs} ms, ~${frames ? Math.round(frameBytes / frames / 1024) : 0} KB/frame (jpeg q60, full pane)`
  );

  results.blocked = blocked;
  results.navMs = navMs;
  results.screenshotBytes = png.length;
  results.screenshotMs = shotMs;
  const passed = results.checks.filter((c) => c.pass).length;
  results.summary = `${passed}/${results.checks.length} checks passed`;
  fs.writeFileSync(path.join(OUT, "results.json"), JSON.stringify(results, null, 2));
  console.log("\n" + results.summary);

  server.close();
  app.exit(passed === results.checks.length ? 0 : 1);
}

app.whenReady().then(() =>
  main().catch((e) => {
    console.error("SPIKE FAILED:", e);
    app.exit(2);
  })
);
