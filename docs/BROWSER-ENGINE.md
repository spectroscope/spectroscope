# The browser engine

The decision behind cards 201 (the visible browser), 202 (launch
configurations) and 204 (the replay), and the measurements it rests on. Cards
cut from this document cite its sections rather than deciding the engine again.

Measured 2026-08-13 on macOS 25.6 (darwin), Electron 43.3.0 (Chromium
150.0.7871.212), Google Chrome 151.0.7922.110, node v25.9.0. The one-major gap
between the bundled Chromium and the system Chrome is itself an argument in
section 2: only one of the two roads lets the product pin its engine version. Every number below came from
`spike/card-200-browser-engine/`, which is a spike and ships in no build.
Re-run it with `spike/card-200-browser-engine/run.sh` (Electron) and
`node spike/card-200-browser-engine/cdp-floor.js` (raw CDP).

## 1. The decision

**Electron's `WebContentsView`, on the desktop face, driven by the Java server
over a control channel the main process opens back to it.**

The trade-off, stated out loud as acceptance criterion 3 demands: **this serves
the desktop face only.** Someone running `spectro web` and pointing their own
browser at the server gets no integrated browser from this decision, and the
desktop shell stops being a thin supervisor and starts carrying a product
feature.

That trade was made rather than swallowed, and section 5 names the price of
reversing it.

### Why

1. **It is the only candidate that pays neither of the two prices.** Every road
   here costs either a download or hand-written engine code. Raw CDP costs an
   estimated 19.5 days of Java (section 4) to reach what a library already
   ships. playwright-mcp costs a 344 MB browser download beside a notarized app
   plus a node runtime the desktop app does not bundle. Electron 43 is already
   inside the signed DMG: the marginal download is **0 MB** and the marginal
   engine code is roughly none, because the four verbs are platform calls.
2. **It answers constraint 1 most directly.** The owner asked for a browser
   like the one in Claude Code, and that is a pane inside the application, not
   a second browser beside it. The brand rule ("the agent orchestrator you can
   watch") is satisfied by watching, not by streaming a picture of watching.
3. **The four pinned eval semantics are native, not opt-in.** On CDP,
   `awaitPromise` and `returnByValue` are flags; forget either and the contract
   silently changes shape (a Promise comes back as an opaque handle, an object
   as an objectId). `webContents.executeJavaScript` has both behaviours built
   in. Measured: 4/4 on both engines, but only one of them can be got wrong.
4. **The fence and the adblock ride one in-process hook that sees every
   request.** `session.webRequest.onBeforeRequest` fires for the top-level
   navigation, **every redirect hop** and every subresource, with no listening
   socket and no second component. This closes, for this engine, exactly the
   hole `BrowsePageTool`'s own javadoc documents and defers: *"Policing the
   browser's own traffic needs a proxy Chrome runs through, and that is its own
   card."* Electron needs no proxy and no card. Section 6.
5. **The engine version becomes ours to move.** The card asks for engine drift
   to be guarded, and the two roads guard it differently. Electron's Chromium
   ships inside the DMG, so it changes when we upgrade Electron and a guard test
   runs in that same commit. System Chrome updates itself on the user's machine
   whenever Google ships, which is how `--headless` and `--dump-dom` became a
   documented hazard for `browse_page` in the first place. Measured today: the
   bundled Chromium is 150.0.7871.212 while the system Chrome is already 151 —
   one major apart on one machine, on one day.

## 2. The candidates against the owner constraints

`*` = measured in the spike; everything else is read from the code or the docs.

| | 1. Electron `WebContentsView` | 2. Raw CDP, system Chrome | 3. playwright-mcp |
|---|---|---|---|
| **PoC result** | **11/11 checks** `*` | 9/9 checks `*` | not run (no install made) |
| Real visible browser | pane **inside** the app window `*` | separate Chrome window, fresh profile `*` | separate Chrome window |
| Eval: page context | native `*` | `Runtime.evaluate` `*` | native |
| Eval: actuator + sensor | native `*` | native `*` | native |
| Eval: Promise awaited | native `*` | needs `awaitPromise:true` `*` | native |
| Eval: JSON-serialized return | native `*` | needs `returnByValue:true` `*` | native |
| Screenshot path | `capturePage()` → PNG, **20–153 ms**, 10.8 KB @1100×760 `*` | `Page.captureScreenshot`, **28–309 ms**, 16.9 KB `*` | crosses MCP, card 198 |
| Live frames (card 204) | `beginFrameSubscription`, 6 frames/1455 ms, ~9 KB/frame `*` | `Page.startScreencast`, **13 frames/1473 ms, ~5 KB/frame** `*` | not exposed |
| Fence across a redirect | one hook, no round trip `*` | `Fetch.requestPaused`, **every** request needs an explicit verdict `*` | outside our process entirely |
| Adblock | same hook, filter list `*` | same `Fetch` domain, same round-trip cost | extension, or nothing |
| Download cost | **0 MB** (already in the DMG) | 0 MB (system Chrome) | **344 MB** chromium + node |
| Startup | pane in a running app; navigate 343 ms `*` | Chrome cold **1297–1395 ms** + fresh profile `*` | Chrome cold + npx cold |
| Hand-written engine code | ~none | **~19.5 days** (section 4) | ~none |
| Faces served | **desktop only** | desktop **and** web | desktop and web |
| Signed/notarized app | no change | no change | unsigned 344 MB payload beside it |
| CI cost | 0 (spike is outside every workflow) `*` | 0 | browser download per run |

### The failure each one invites

Acceptance criterion 1 asks for the failure, not only the price.

- **Electron** invites *feature creep into the shell*. `spectro-desktop` is
  1,370 lines whose job is to supervise a JVM and show a window. It has no
  preload script at all, and `navigationGuard.ts` names that as a security
  property rather than an omission. A browser pane gives the shell a control
  surface, a second `WebContents` with its own session, and a reason to grow.
  The failure mode is a desktop shell nobody can reason about any more, and a
  browser that is unreachable from the web face forever because the seam was
  never drawn.
- **Raw CDP** invites *a half-built Playwright*. The stress test closed
  Playwright-Java partly for rebuilding Microsoft's 36k-star product; this road
  rebuilds it from a lower floor, in Java, with the per-session executor thread
  to keep safe. The failure mode is the estimate in section 4 being spent, and
  the result still being worse at the parts that are boring to write (snapshot
  reading, input, tab lifecycle). The second failure is quieter: `Fetch`-domain
  interception makes **our process** responsible for continuing every single
  request, and one missed verdict hangs the page with no error.
- **playwright-mcp** invites *a supply chain and a signing problem*. It needs
  node and npx on a machine where the product deliberately bundles a JRE and
  nothing else, and it puts 344 MB of unsigned browser next to a notarized app.
  It also ships `browser_run_code_unsafe`, which runs in the **Node** context
  with full filesystem reach. Card 199's tier map already anticipates this and
  pins that one tool to `eval-execute` while leaving the rest of the server
  unmapped, so the co-approval is closed today. The failure mode is not the
  gate, it is the notarization story and a dependency the zero-dependency
  policy exists to refuse.

## 3. The four pinned eval semantics

The card cites `browser-eval-semantics.md`. **That file does not exist anywhere
in the project** (searched 2026-08-13). The semantics survive only in the card
text, so they are restated here and this section is now their home.

1. The script runs **in page context** — it can see page globals, not merely a DOM.
2. It works as **actuator and sensor in one call** — click, plus the native
   setter and a dispatched event for React-shaped inputs, plus a read-back.
3. **Promises are awaited**, not stringified into an opaque handle.
4. The return value comes back **JSON-serialized**.

Interface: a single action `javascript_exec`, one text parameter, an optional
tab id.

All four are proven on both engines in the spike. The check that pins semantic 1
is worth keeping: the broken variant runs the same code in an **isolated world**,
which has the same DOM and no page globals, and returns `undefined`. That is
precisely the failure a "close enough" eval implementation ships with.

## 4. What candidate 2 would have cost (criterion 7)

Criterion 7 makes a per-component day estimate a condition of any
recommendation. The estimate below is anchored on a measurement rather than a
feeling: the spike reached navigate + 4 evals + screenshot + a `Fetch` fence +
a screencast over **raw CDP in 162 non-comment lines of JavaScript**, happy path
only, one tab, no input, no console, no lifecycle, no thread safety. Java with
`java.net.http.WebSocket`, Jackson, TDD and the house gate is the multiplier.

| Component | Days |
|---|---|
| CDP WebSocket client, request/response correlation, event demultiplexing | 2.0 |
| Target/session lifecycle: attach, detach, tab open/close/switch | 2.0 |
| Navigate with lifecycle waits (commit vs load), timeouts, cancellation | 1.5 |
| Eval with the four pinned semantics and `exceptionDetails` error mapping | 1.0 |
| Screenshot capture plus the ImageStore/attach wiring (card 198 path) | 1.0 |
| Input injection: `Input.dispatchMouseEvent`/`dispatchKeyEvent`, modifiers | 2.0 |
| Text/accessibility snapshot reader (the stated default output mode) | 2.5 |
| Console and network capture | 1.0 |
| `Fetch`-domain fence: a verdict per request, redirect chains, failure modes | 2.0 |
| Per-session thread safety against the executor architecture | 1.5 |
| Screencast into card 204's sidecar and live frames | 1.5 |
| Chrome discovery, launch, profile handling, crash supervision | 1.0 |
| The drift guard test the gate gets (section 7) | 0.5 |
| **Total** | **19.5** |

**Against a three-day time box that is 6.5×.** Per the card's own open owner
call, the spike says so and stops rather than starting that build.

Two costs on this road are structural rather than estimated, and no amount of
days removes them:

- Chrome refuses `--remote-debugging-port` on the default profile, so the
  visible window is a **fresh browser with none of the user's tabs, logins or
  extensions** (measured: the spike creates a throwaway profile each run). For a
  tool whose first constraint is "local testing", that is survivable. For
  anything touching a logged-in session it is not.
- `Fetch`-domain interception routes **every request** through the JVM for an
  explicit continue. That is the fence and the adblock on the same mechanism,
  and it is a per-subresource round trip that Electron's hook does not pay.

## 5. What the decision does not close

Choosing Electron does **not** foreclose the web face, provided card 201 draws
the seam named here.

The agent-side contract is four verbs — `navigate`, `javascript_exec`,
`screenshot`, `frames` — plus the fence policy and the tier entries. If card 201
implements that contract behind an interface in Java, with the Electron control
channel as the first implementation, then a later CDP implementation serves the
web face **without touching the tool surface, the fence policy, the tier map or
card 204's sidecar format**. What would be spent then is section 4's estimate,
and it is not spent now on a face nobody has asked for yet.

**If the owner wants the browser on the web face in 0.9, this decision flips to
candidate 2 and the time box has to grow to roughly 20 days.** That is an owner
call, not a spike's call, because it trades the zero-dependency policy and the
schedule against a face. It is listed in section 9.

## 6. Threat model: what the design refuses by shape

The net fence (`NetFence`, card 199) blocks `file://`, every non-http(s)
scheme, RFC-1918, 100.64/10 (the tailnet), link-local, IPv6 unique-local,
multicast and broadcast, with loopback as an **explicit opt-in** for the local
verify loop. On this machine the reach that matters is the board on :8746,
ollama on :11434 and the tailnet.

What the chosen engine changes, and this is the security argument for it:

- **Today** `browse_page` is judged at the address it is handed **and no
  further**. Its javadoc says so plainly. Once Chrome runs, it follows
  redirects and executes page JavaScript that can navigate anywhere, and none
  of those requests return through the JVM.
- **On the chosen engine** every request is judged. The spike proves the
  concrete case the entry check cannot see: the agent is handed a **loopback**
  address (allowed, opt-in), the server answers **302 → `http://192.168.1.1/admin`**,
  and the private hop is refused mid-journey with `ERR_BLOCKED_BY_CLIENT`.
  Breaking the hook turns that check red, which is how we know it is the hook
  doing the work.

Rules the browser family inherits and card 201 may not relax:

1. A page is **attacker-influenced input**. Nothing a page says is an
   instruction, and no page-supplied URL is followed into private space.
2. The fence is enforced **in the request hook**, not at the tool boundary, so
   redirects and subresources are covered rather than the first address only.
3. Refusals name **the address and the rule and nothing else** — no headers, no
   tokens, no query strings, since a refusal reaches the model and the
   transcript.
4. `javascript_exec` runs in the **page** context, never a Node context. There
   is no equivalent of `browser_run_code_unsafe` here, and none gets added.
5. Tiers per card 199: `screenshot` and a text snapshot are `read`, `navigate`
   and input are `write`, `javascript_exec` is **`eval-execute`**. A `:read`
   wildcard must never approve an eval. New tools land in
   `spectro-core/src/main/resources/permission/tool-tiers.json`, and anything
   absent falls to `eval-execute` by construction.

## 7. The drift guard the gate gets

The engine's assumptions must fail loudly when a Chromium major moves under
them. The guard test asserts, against the shipped Electron:

- `webContents.executeJavaScript` still awaits a returned Promise and still
  returns a structured value (semantics 3 and 4, the two that are flags on CDP);
- `session.webRequest.onBeforeRequest` still fires for a **redirect hop**, which
  is the whole fence;
- `capturePage()` still returns PNG bytes above a floor size.

It belongs where `spectro-desktop` can run it, and `spectro-desktop` has no test
runner today and no `gate.yml` job. **Standing up that runner is part of card
201, not an afterthought** — the guard is the reason the engine choice stays
honest across upgrades.

## 8. Operational findings the spike paid for

- **`capturePage()` throws `UnknownVizError` when the pane has not painted
  yet.** It does not return an empty image, which is the kinder failure. A
  screenshot action must wait for paint; the spike's `SPIKE_BREAK=settle` run
  is the proof, and it turns two checks red.
- **Screenshots are cheap here.** A full 1100×760 pane is 10.8 KB of PNG,
  against `McpTool.MAX_IMAGE_BYTES` (the providers' wire limit). Downscaling is
  not needed at this size. The stated default stands anyway — **text snapshots
  by default, vision opt-in** — because the cost that matters is vision tokens
  per turn, not bytes on disk. Nothing measured here overturns it.
- **Live frames are affordable on both engines**: ~5 KB/frame (CDP jpeg q60
  @800×600) and ~9 KB/frame (Electron, full pane). At the ~9 fps observed that
  is roughly 45–80 KB/s for card 204's socket-only stream.

## 9. Open questions, listed as open

1. **The time box.** Three working days was the card's proposal and was never
   agreed. The spike (decision + PoC) fits it. **Card 201's build does not fit
   it on any candidate** — roughly 10 days on the chosen engine, 19.5 on CDP.
2. **The web face.** Deferred, not solved. Section 5 names the seam that keeps
   it cheap and the price if 0.9 must have it.
3. **The control channel's shape.** The main process opening a WebSocket back
   to the server avoids adding a preload script, which `navigationGuard.ts`
   treats as a security property. The alternative (preload + `ipcMain`) is more
   conventional and weakens that stance. Recommended: main-process client.
   Not yet decided.
4. **Adblock's filter list.** Proven possible on the request hook with a stand-in
   list. Which list, how it updates, and what it costs to ship are unanswered.
5. **`spectro-desktop` has no test runner**, so the section 7 guard has nowhere
   to run yet.
6. **playwright-mcp was judged without being installed.** An npm download was
   not made for this spike. Its row in section 2 is read from code and docs, not
   measured, and it is the one row that would change if someone ran it.
