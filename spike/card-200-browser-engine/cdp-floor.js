// Candidate 1, measured instead of estimated (card 200, criterion 7).
//
// The card demands a per-component day estimate for "hand-write CDP in Java,
// zero new dependencies" rather than a preference. An estimate written without
// touching the protocol is a guess, so this reaches the SAME three verbs
// against the SAME fixture over raw CDP, counting what it actually costs.
//
// Node's global WebSocket (22+) stands in for Java's java.net.http.WebSocket,
// which is the honest Java equivalent: both are in the platform, so "zero new
// dependencies" is true on both sides and the comparison is about the code
// above the socket, not about the socket.
//
// This is the FLOOR, not the product: one tab, no lifecycle, no input, no
// console, no thread safety, happy path only. What it takes to reach the floor
// is the multiplier for what the ceiling costs.

const { spawn } = require("child_process");
const fs = require("fs");
const path = require("path");
const fixture = require("./fixture-server");

const PORT = 8772;
const DEBUG_PORT = 9333;
const OUT = path.join(__dirname, "out");
const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

let nextId = 1;
const pending = new Map();

/** One CDP request/response pair — the correlation a hand-written client owes. */
function send(ws, method, params = {}, sessionId) {
  const id = nextId++;
  const msg = { id, method, params };
  if (sessionId) msg.sessionId = sessionId;
  ws.send(JSON.stringify(msg));
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    setTimeout(() => {
      if (pending.delete(id)) reject(new Error(`CDP timeout: ${method}`));
    }, 15000);
  });
}

async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  const server = await fixture.start(PORT);
  const base = `http://127.0.0.1:${PORT}`;
  const checks = [];
  const record = (name, pass, detail) => {
    checks.push({ name, pass, detail });
    console.log(`${pass ? "PASS" : "FAIL"}  ${name}${detail ? " — " + detail : ""}`);
  };

  // A separate profile: attaching to the owner's running Chrome is not an
  // option, and Chrome refuses --remote-debugging-port on the default profile
  // anyway. This is a real cost of candidate 1 — the visible window is a FRESH
  // browser, not the one with the user's tabs and logins in it.
  const profile = fs.mkdtempSync("/tmp/cdp-spike-");
  const t0 = Date.now();
  const chrome = spawn(CHROME, [
    `--remote-debugging-port=${DEBUG_PORT}`,
    `--user-data-dir=${profile}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--homepage=about:blank",
    "about:blank",
  ]);

  // Discovering the endpoint is its own little wait-loop, hand-written.
  let wsUrl = null;
  for (let i = 0; i < 60 && !wsUrl; i++) {
    await new Promise((r) => setTimeout(r, 100));
    try {
      const res = await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/version`);
      wsUrl = (await res.json()).webSocketDebuggerUrl;
    } catch { /* not up yet */ }
  }
  const startupMs = Date.now() - t0;
  if (!wsUrl) {
    console.error("chrome never opened its debug port");
    chrome.kill();
    server.close();
    process.exit(2);
  }
  record("chrome starts headful with a debug port", true, `${startupMs} ms, fresh profile ${profile}`);

  const ws = new WebSocket(wsUrl);
  await new Promise((r) => (ws.onopen = r));
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) {
      const { resolve, reject } = pending.get(m.id);
      pending.delete(m.id);
      m.error ? reject(new Error(m.error.message)) : resolve(m.result);
    }
    // Events land here too. A real client demultiplexes them per session and
    // per domain; the floor drops them on the floor.
  };

  // Attaching to a target, flat mode. Sessions are the part that makes a
  // hand-written client fiddly: every later message needs its sessionId.
  const { targetInfos } = await send(ws, "Target.getTargets");
  const page = targetInfos.find((t) => t.type === "page");
  const { sessionId } = await send(ws, "Target.attachToTarget", { targetId: page.targetId, flatten: true });
  await send(ws, "Page.enable", {}, sessionId);
  await send(ws, "Runtime.enable", {}, sessionId);

  // ---- navigate ---------------------------------------------------------
  // Page.navigate resolves when the navigation COMMITS, not when the page is
  // usable, so "navigate finished" is a hand-written wait on a lifecycle event.
  const navStart = Date.now();
  const loaded = new Promise((resolve) => {
    const onMsg = (ev) => {
      const m = JSON.parse(ev.data);
      if (m.method === "Page.loadEventFired" && m.sessionId === sessionId) {
        ws.removeEventListener("message", onMsg);
        resolve();
      }
    };
    ws.addEventListener("message", onMsg);
  });
  await send(ws, "Page.navigate", { url: base + "/" }, sessionId);
  await loaded;
  const navMs = Date.now() - navStart;
  record("navigate: Page.navigate + a hand-written load wait", true, `${navMs} ms`);

  // ---- eval -------------------------------------------------------------
  const ctx = await send(ws, "Runtime.evaluate", {
    expression: `window.__PAGE_MARKER__`,
    returnByValue: true,
  }, sessionId);
  record("eval 1/4: page context", ctx.result.value === "page-context-ok", `got ${JSON.stringify(ctx.result.value)}`);

  const act = await send(ws, "Runtime.evaluate", {
    expression: `(() => {
      const b = document.getElementById('counter'); b.click(); b.click();
      const i = document.getElementById('field');
      Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value').set.call(i,'driven-by-eval');
      i.dispatchEvent(new Event('input',{bubbles:true}));
      return { button: b.textContent, echo: document.getElementById('echo').textContent };
    })()`,
    returnByValue: true,
  }, sessionId);
  record(
    "eval 2/4: actuator and sensor",
    act.result.value.button === "clicked 2 times" && act.result.value.echo === "echo:driven-by-eval",
    JSON.stringify(act.result.value)
  );

  // awaitPromise is an explicit FLAG here. Forget it and a Promise comes back
  // as an opaque handle — the semantics are opt-in, not the default.
  const slow = await send(ws, "Runtime.evaluate", {
    expression: `fetch('/slow.json').then(r=>r.json()).then(j=>j.slow+'-after-250ms')`,
    awaitPromise: true,
    returnByValue: true,
  }, sessionId);
  record("eval 3/4: Promise awaited (needs awaitPromise:true)", slow.result.value === "arrived-after-250ms", JSON.stringify(slow.result.value));

  // returnByValue is the other explicit flag; without it you get objectIds and
  // must walk them yourself.
  const shaped = await send(ws, "Runtime.evaluate", {
    expression: `({ n: 42, list:[1,2,3], nested:{ok:true}, when:null })`,
    returnByValue: true,
  }, sessionId);
  const v = shaped.result.value;
  record("eval 4/4: JSON-serialized return (needs returnByValue:true)", v.n === 42 && v.list.length === 3, JSON.stringify(v));

  // ---- screenshot -------------------------------------------------------
  await new Promise((r) => setTimeout(r, 600));
  const shotStart = Date.now();
  const shot = await send(ws, "Page.captureScreenshot", { format: "png" }, sessionId);
  const png = Buffer.from(shot.data, "base64");
  const shotMs = Date.now() - shotStart;
  const file = path.join(OUT, "cdp-screenshot.png");
  fs.writeFileSync(file, png);
  const isPng = png[0] === 0x89 && png[1] === 0x50;
  record("screenshot: Page.captureScreenshot returns PNG", isPng && png.length > 5000, `${png.length} bytes, ${shotMs} ms → ${file}`);

  // ---- the fence question ----------------------------------------------
  // This is where candidate 1 stops being comparable. CDP CAN police requests,
  // via Fetch.enable + Fetch.requestPaused, but that turns every request into a
  // round trip through our process, which must then explicitly continue each
  // one. Measured here only as "can it see the hop at all".
  await send(ws, "Fetch.enable", { patterns: [{ urlPattern: "*" }] }, sessionId);
  let sawPrivateHop = false;
  const fenceWatch = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.method === "Fetch.requestPaused" && m.sessionId === sessionId) {
      const url = m.params.request.url;
      if (url.includes("192.168.1.1")) sawPrivateHop = true;
      // EVERY request now needs an explicit verdict or the page hangs.
      send(ws, url.includes("192.168.1.1") ? "Fetch.failRequest" : "Fetch.continueRequest",
        url.includes("192.168.1.1")
          ? { requestId: m.params.requestId, errorReason: "BlockedByClient" }
          : { requestId: m.params.requestId },
        sessionId).catch(() => {});
    }
  };
  ws.addEventListener("message", fenceWatch);
  await send(ws, "Page.navigate", { url: base + "/redirect-to-private" }, sessionId);
  await new Promise((r) => setTimeout(r, 1500));
  record("fence: the private hop is visible via Fetch.requestPaused", sawPrivateHop, sawPrivateHop ? "seen and failed" : "not seen");

  // ---- the live-frame question (card 204's socket-only frames) ----------
  // If watchability is delivered as FRAMES OVER A SOCKET rather than as an
  // embedded pane, the engine only has to emit frames — and that is the one
  // thing that decides whether a candidate can serve the web face at all.
  // CDP has a purpose-built domain for it.
  await send(ws, "Fetch.disable", {}, sessionId);
  ws.removeEventListener("message", fenceWatch);
  await send(ws, "Page.navigate", { url: base + "/" }, sessionId);
  await new Promise((r) => setTimeout(r, 400));

  let frames = 0;
  let frameBytes = 0;
  const onFrame = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.method === "Page.screencastFrame" && m.sessionId === sessionId) {
      frames++;
      frameBytes += m.params.data.length;
      send(ws, "Page.screencastFrameAck", { sessionId: m.params.sessionId }, sessionId).catch(() => {});
    }
  };
  ws.addEventListener("message", onFrame);
  const castStart = Date.now();
  await send(ws, "Page.startScreencast", { format: "jpeg", quality: 60, maxWidth: 800, maxHeight: 600, everyNthFrame: 1 }, sessionId);
  // Give the page something to repaint, so frames have a reason to arrive.
  for (let i = 0; i < 12; i++) {
    await send(ws, "Runtime.evaluate", { expression: `document.getElementById('counter').click()` }, sessionId);
    await new Promise((r) => setTimeout(r, 120));
  }
  await send(ws, "Page.stopScreencast", {}, sessionId);
  const castMs = Date.now() - castStart;
  ws.removeEventListener("message", onFrame);
  record(
    "live frames: Page.startScreencast emits a continuous stream",
    frames >= 3,
    `${frames} frames in ${castMs} ms, ~${frames ? Math.round(frameBytes / frames / 1024) : 0} KB/frame (base64 jpeg q60 @800x600)`
  );

  const passed = checks.filter((c) => c.pass).length;
  console.log(`\n${passed}/${checks.length} checks passed`);
  fs.writeFileSync(path.join(OUT, "cdp-results.json"), JSON.stringify({ engine: "raw-cdp-system-chrome", startupMs, navMs, shotMs, screenshotBytes: png.length, checks }, null, 2));

  ws.close();
  chrome.kill();
  server.close();
  // Chrome writes its profile down as it dies, so a rm right after kill races
  // it. Give it a beat, and never let cleanup decide the exit code.
  await new Promise((r) => setTimeout(r, 300));
  try {
    fs.rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  } catch (e) {
    console.warn(`(left ${profile} behind: ${e.code})`);
  }
  process.exit(passed === checks.length ? 0 : 1);
}

main().catch((e) => { console.error("CDP FLOOR FAILED:", e); process.exit(2); });
