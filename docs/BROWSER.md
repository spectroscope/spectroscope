# The visible browser

What cards 201 and 218 built, where it lives, and the things it deliberately
does not do. The engine decision underneath it is card 200's and is not
re-argued here; `docs/BROWSER-ENGINE.md` is its home.

## One browser per session

**The browser belongs to a session, not to the program.** The owner settled that
while card 201 was still building: *"weil jede session braucht ja seinen eigenen
browser"*. So a browser instance is keyed by session id, built the first time
that session's agent calls a browser tool, and it holds that session's page, its
cookies and its scroll position and nobody else's.

**How the isolation is achieved.** Each session's view browses in its own
Electron `Session`,
`session.fromPartition("spectro-browser/<id>-<fingerprint>-<opening>")`. That is
Chromium's own boundary: the cookie jar, `localStorage`, IndexedDB, the HTTP
cache and the credential store all hang off that object, and two partitions
share none of them. Nothing in `browserPane.ts` has to remember to keep two
sessions apart, and nothing in it could merge them by accident. The fingerprint
is of the raw id, because the sanitising that makes an id safe as a path
component is lossy — `ab/c` and `ab:c` both flatten to `ab_c`, and two sessions
on one partition is the failure this whole surface exists to prevent.

It is **not** a `persist:` partition. The lifetime rule is "until the session is
closed", and a persistent partition would leave a directory per session id that
nothing ever deletes — plus a resumed id would open onto the cookies of a run
that ended days ago.

**What "closed" means, and what it took to make that true.** The session's
socket going away — the tab or window that held it. That is the same event that
already cancels its run, releases its parked permission questions and lets its
live-session id go (`SessionConnection.onClose`). The stored JSONL survives and
so does the session id; the browser does not, because a browser is live state and
not a record. A resumed session gets a fresh browser, logged out, and a session
that never sent a prompt never minted an id and never had a browser to close.

That last sentence was **false when this page first shipped**, and the correction
is worth keeping written down because the reasoning that produced it sounds
right. "An in-memory session dies with the object" is a promise about the *disk*,
not about the *process*: Electron caches an in-memory `Session` by partition name
for the life of the app. Closing a session dropped the pane and closed the page
and left the cookie jar exactly where it was — measured, five closed sessions
still held five jars, and a session resumed under the same id opened onto its own
old login, HttpOnly cookie included. Two things fix it, and neither is enough
alone:

- **the Chromium session is emptied on close** — `clearStorageData()` and
  `clearCache()`, so the credential leaves the process rather than waiting for
  the app to quit;
- **every OPENING gets its own partition name** — because the request hook is
  installed once per Chromium session and closes over the pane it was handed. A
  second life on the old session went on blocking and stopped *saying* so: the
  model got `ERR_BLOCKED_BY_CLIENT`, the one code an ad blocker, a content
  extension and the net fence are indistinguishable behind, and
  `browser_read_console` reported no refusals at all.

**The proof, not the claim.** `npm run guard` drives the shipped Chromium:

- *isolation* — a page sets a cookie and a `localStorage` token under session A,
  A reloads and still has them, and session B loads the same origin and finds
  `{"cookie":"","token":null}`; Electron's own cookie store agrees, one entry for
  A and none for B. `GUARD_BREAK=partition` gives both sessions one partition and
  the same check reads back `secret-of-A` in B, which is what card 201 shipped.
- *lifetime* — through the product's own `runVerb`: the login really is in that
  session's jar while it is open, the jar is empty after the close, the same id
  reopened is logged out, and its fence still answers "refused 192.168.1.1: it is
  a private network address, RFC 1918 (rule: rfc1918)" rather than an error code.

The whole chain says the same thing:
`BrowserLiveDriveTest.aResumedSessionGetsAFreshBrowserAndAFenceThatStillNamesItself`
logs in through the real seven tools, closes the session, resumes the same store
id and reads back `{"cookie":"","token":null}`.

## Where the pane lives: two doors, one browser

**A surface inside the spectroscope desktop app**, reachable two ways, because
the owner asked for both:

- the **`browser` tab** in the session's own tab row, beside chat, spectrum,
  trace, graph, text and lab — which binds it to the session by construction and
  gives it an address, `#/session/{id}/browser`;
- the rail's **Browser** segment, the large view onto the **current** session's
  browser.

Both mount the same component with the same session id, and the shell keys its
views by that id, so the second door is a view and never a second instance. Only
one of them can be on screen at a time — they are two arms of one layout — and
whichever is showing posts the rectangle it reserved. `sessionBrowser.drift.test.ts`
holds that: two mounts, one `sessionId` expression.

The segment draws a frame with an address line; the page inside it is a real
Chromium view the shell lays over that rectangle.

The agent does not need the reader to open the surface first. When a browser
tool runs, the shell shows that session's pane and asks the app's page to switch
to the Browser segment, so the operator ends up looking at the page the agent is
driving. **Exactly one pane is ever on screen**: bringing one forward takes every
other session's off. Two native overlays stacked over one rectangle is the
failure a `div` could never make, and the operator would be watching the top one
while the agent drove the other.

**The trade, ratified by the owner: this is the desktop face only.** A reader
who runs `spectro web` and points their own browser at the server gets a segment
that says so:

> No browser pane attached. The visible browser is a surface INSIDE the desktop
> app; a reader who opens spectro web in their own browser gets no page here.

Card 200 closed the iframe alternative for three reasons and this card does not
reopen it: foreign sites refuse framing, the same-origin policy forbids reading
or scripting what is framed (which kills `browser_eval`, 41 % of the measured
calls), and frame content cannot be rasterised. Card 200 section 5 names the
seam that keeps a later web-face implementation cheap, and this card implemented
that seam: `dev.spectroscope.core.browser.BrowserFace`.

## The seven tools

Not guessed — measured from 3,447 real browser calls across 35 sessions in the
owner's own transcripts.

| tool | tier | what it does |
|---|---|---|
| `browser_navigate` | write | points the pane at a URL, waits for the load |
| `browser_computer` | write | screenshot, click, type, key, scroll, hover, wait |
| `browser_eval` | **eval-execute** | runs JavaScript **in the page** and returns the value |
| `browser_read_page` | read | the accessibility tree with `ref_N` handles |
| `browser_find` | read | finds elements by description, returns handles |
| `browser_read_console` | read | what the PAGE logged, plus what the fence refused |
| `browser_resize` | write | emulates a device: metrics, touch and a user agent |

The page persists between calls. Navigate once, then read, eval and click.

### Why `browser_eval` is `eval-execute`

Deliberate, and written down because card 199's whole point is that a wildcard
must not approve more than the reader meant. An eval runs model-authored
JavaScript **in the page's own context**: it holds that origin's cookies, its
`localStorage`, its session and its `fetch` credentials, and it can act — click,
submit, navigate — with the authority of whoever is logged in there. That is code
execution, and the page it runs against is attacker-influenced input. So it sits
beside `run_command`, and a `:read` ceiling can never approve it.

`browser_computer` bundles a screenshot (read) with input injection (write). A
tool's tier is its widest capability, so it is `write`; a reader who wants
looking without touching uses `browser_read_page`.

There is no Node-context eval here and none gets added.

### The four pinned eval semantics

Owner-pinned, from his own reference call, and native on this engine rather than
opt-in:

1. runs in the **page** context — `document`, `window`, `localStorage` are the
   page's own;
2. **acts and senses in one call** — click, write through the native value setter
   plus a dispatched event, then read back a verdict;
3. **awaits a returned Promise** before serializing;
4. returns the **resolved value JSON-serialized**.

All four are asserted against the shipped Electron by
`spectro-desktop/test/engineGuard.js`, each with a switch that removes the
mechanism so the check can be seen going red.

## Screenshots

A screenshot never appears as base64 in the tool's text output. It travels the
path card 198 built:

1. the pane's PNG bytes land in the `ImageStore` under their SHA-256;
2. an `image_generated` reference event is emitted (`provider: "browser"`);
3. the image is **attached** for the model to see.

The media type is canonicalized first, against exactly the set
`GET /api/images/{file}` can serve back. A type this chain cannot carry is
refused with its type named — nothing stored, nothing announced, nothing on the
wire.

## The net fence, in two halves

Card 199's fence is on by default: `file://`, every non-http(s) scheme, RFC-1918,
100.64/10, link-local, IPv6 unique-local, multicast and broadcast are refused,
and **loopback is refused until the operator opts in**.

The fence runs **twice**, on purpose, and the two halves reach different things:

| | where | what it judges |
|---|---|---|
| entry check | `NetFence`, in the JVM | the address the tool was handed, with DNS resolved and every answer checked |
| in-hook fence | `browserFence.ts`, in `session.webRequest.onBeforeRequest` | the top-level navigation, **every redirect hop** and **every subresource**, with DNS resolved and every answer checked |

The second is the one `browse_page` never had. Its javadoc says so plainly:
"policing the browser's own traffic needs a proxy Chrome runs through, and that
is its own card". This engine needs neither.

Both halves read the same vector table,
`spectro-core/src/main/resources/browser/fence-vectors.json`, and both are tested
against it: `vectors` for address literals, `names` for host names with the DNS
answer written down so both sides can be driven by the same answer without a
network. Where they honestly differ the table carries a **divergence register**
and both sides assert their own column. The interesting row, measured on
2026-08-13: Java's `InetAddress` reads `http://0177.0.0.1/` as the public
`177.0.0.1` and the entry check allows it, while Chromium reads octal loopback
and dials `127.0.0.1` — only the in-hook fence sees what was actually dialled.

### Two holes a review measured, and what closed them

Both were in the hook — the half that exists to police redirects, where the
entry check never gets a vote. Both were found by driving the browser, not by
reading the diff, on 2026-08-13.

1. **An IPv4-mapped IPv6 literal walked through.** The rule table matched on the
   spelling (`::1`, `fe8`, `fc`, `ff`) and had no `::ffff:` case, so
   `http://[::ffff:192.168.1.1]/` fell through to allowed. A 302 to it returned
   `ERR_CONNECTION_TIMED_OUT` with **zero** refusals — the packet had left for
   the LAN — while the plain literal returned `ERR_BLOCKED_BY_CLIENT`. The hook
   now parses an IPv6 literal into its sixteen bytes and judges the ADDRESS: a
   mapped address is the IPv4 address underneath it, in every spelling.
2. **The loopback opt-in was bypassable by name.** The hook skipped DNS on the
   argument that a resolver call per subresource is a round trip on the critical
   path, and this document called that a documented split. It was a hole: with
   `allowLocalhost` off, a 302 to a public name resolving to `127.0.0.1` loaded,
   titled itself PWNED, and refused nothing. `onBeforeRequest` may answer
   asynchronously, so the hook now resolves too, with answers cached per host
   for 30 seconds.

**What still is not caught, by either half.** A DNS record whose answer changes
between the fence's lookup and Chromium's own connection — classic rebinding —
is outside what either can promise, because neither of them is the one that
dials. That sentence is in the browser segment where the operator reads it, not
only here.

Deliberately not treated as private: IPv4-compatible (`::192.168.1.1`) and NAT64
(`64:ff9b::192.168.1.1`) spellings. Both halves read them as ordinary IPv6
addresses and both allow them, and they agree because neither reaches the
embedded v4 address without translation infrastructure in the path.

### Turning localhost on, which is the primary use

The owner's stated primary use is the **local verify loop**: a dev server on
localhost. That is refused by default, and the refusal says how to change it:

```
ERROR: browser_navigate refused localhost:5173: it is this machine, and the
local verify loop is not opted in (set allowLocalhost in the settings to reach
it on purpose) (rule: loopback). The address it was given: http://localhost:5173/.
```

To turn it on, put it in the settings — `~/.spectro/settings.json`, or the
project's own settings file:

```json
{ "allowLocalhost": true }
```

or set `SPECTRO_ALLOW_LOCALHOST=1` in the environment. It is read fresh per
call, so a saved setting reaches the next tool call rather than the next launch,
and it is read by **both** halves of the fence from the same place. The opt-in
never widens: the LAN, the tailnet and `file://` stay refused with it on.

### Every failure sentence names the address

House rule from cards 193 and 203. `browser_navigate` names its own argument;
the six tools that act on whatever is open name the page they ran on; and with
no browser attached at all the sentence still names what was asked for and says
which face carries a browser. A refusal carries the host and port and nothing
else — no path, no query, no userinfo, because a refusal reaches the model and
the transcript.

## Resizing, which means emulating a device

`browser_resize` overrides what the **page** believes, in the renderer, where a
responsive layout reads it. It does not resize the pane: the pane's rectangle
belongs to the app's layout, and the first version fought it and lost — it called
`setBounds`, which `layout()` overwrote from `paneBounds()` on the next
`ensureVisible()`, and navigate, eval, screenshot and input all call
`ensureVisible()` first.

Three overrides, all in one debugger session:

| | how |
|---|---|
| device metrics | `Emulation.setDeviceMetricsOverride` |
| touch | `Emulation.setTouchEmulationEnabled` + `setEmitTouchEventsForMouse`, five points under 768 wide |
| user agent | `setUserAgent` plus `Emulation.setUserAgentOverride`, in place from the **next** load |

The order is the mechanism, and it cost a measurement: **attaching the debugger
clears what `webContents.enableDeviceEmulation` set.** Metrics first then attach
left `screen.width` at 3440 — the real monitor. Attach first, then metrics
through the same session, and the same page reported 375. So the debugger goes
on first; `enableDeviceEmulation` is the fallback for a pane whose debugger will
not attach, and then the answer says touch is off rather than claiming a phone.

**The answer is the measurement, not the argument.** Every number in the sentence
comes back from the page:

```
The viewport of http://localhost:5173/ is now 375x812, touch emulation is on
with 5 points, and a mobile user agent applies from the next load. The page
itself lays out at 981x2123: it declares no <meta name="viewport">, so it gets
the legacy 980-pixel layout a real phone would give it too. Reload the page so
load-time device checks run again.
```

That second sentence is the useful one and it is why the device size and the
layout viewport are reported separately. A tool that answered with its own
argument could never be wrong, which is exactly what the first version was: it
reported "375x812 (mobile emulation on)" while the page measured 800x740, zero
touch points and a Macintosh user agent.

## Adblock

**Outcome: it works.** Filter-list blocking rides the same
`onBeforeRequest` hook the fence rides, so the marginal cost of a list is a
string match rather than a second component. `engineGuard.js` proves it live:
the ad script never runs, the page's own script does.

What ships is a **small curated list**, not EasyList. Card 200 section 9 left
"which list, how it updates, what it costs to ship" open and it is still open —
a 100k-rule list is a download, an update channel and a licence question. The
shipped list covers the exchanges and tag managers that carry most third-party
ads, plus a few generic paths.

The honest limits, stated rather than discovered:

- it **blocks network requests**; it does not hide elements. Cosmetic rules
  (`example.com##.ad-banner`) are parsed and **dropped**, because this hook
  cannot enforce them and a rule that half works is worse than one that is
  absent;
- rule options (`$third-party`, `$script`) are not modelled;
- the **top-level document is never blocked** — a filter list is a heuristic and
  one that can blank the pane would cost more trust than the ads it removes.

Point `SPECTRO_BROWSER_FILTERS` at a file of ABP-syntax rules to use your own
list. Set `SPECTRO_BROWSER_ADBLOCK=off` to turn it off — useful when the page
under test is the ad.

## What browser_read_console leaves out

Electron writes its own security warning into the console of every page in a
development build — ten lines, twice after a redirect. The tool whose job is "the
first place a broken local build says what is wrong" was shipping that on top of
the page's own output, so the shell's warning is filtered out. It is **counted**,
not silently dropped:

```
(2 Electron security warning(s) from the shell itself left out — they are not
the page's)
```

That sentence never appeared until 2026-08-13, and the filter under it had never
matched a single line. Electron 43 writes `console.warn("%cElectron Security
Warning (…)%c\n…", "font-weight: bold;", "")`, so the message arrives with the
format directive still on the front and an anchored `^\s*Electron Security
Warning` matches nothing. The filter now allows the directives, the counter can
therefore be non-zero, and the guard asserts it against the string **this**
Electron emits rather than the one the filter was written for — measured at 7
emitted, 0 leaked.

## How it is wired

```
model ──► BrowserTools (spectro-core)         seven tools, schemas, tiers,
              │                                entry fence, image path
              ▼
         BrowserFace                          ONE browser — the seam card 200
              │                                section 5 asks for
              ▲
         BrowserFaces.forSession(id)          the keying, card 218. The server
              │                                picks the id; nothing the model
              │                                writes can.
              ▼
    BrowserControlSocket (spectro-server)     /ws/browser, one shell at a time,
              │                                every send on a deadline and
              ▼  (the MAIN process dialled IN)  carrying its sessionId
      browserControl.ts ──► browserPane.ts    a WebContentsView and an Electron
                                   │           session PER spectroscope session
                                   ▼
                          the pane the operator watches
```

**Why the keying is not a method on `BrowserFace`.** A `BrowserFace` is one
browser: attached or not, showing one address, one verb at a time. That is all
`BrowserTools` should ever know. Keying belongs to the object that owns the
channel, and splitting them means the tools cannot address a session even in
principle — they are handed one already-resolved face, and no argument on any of
the seven schemas could name another. The isolation is then a property of the
wiring rather than a rule somebody has to keep.

The control channel points **from the shell to the server**, not the other way.
Card 200 section 9.3 left the shape open and recommended this one: the
alternative is a preload script plus `ipcMain`, and `navigationGuard.ts` names
"this shell has no preload script at all" as a security property rather than an
omission. A main-process client keeps it.

**What `/ws/browser` trusts, said out loud.** The channel authenticates nothing
beyond being on loopback with an accepted `Origin`, and the newest connection
wins: any process on this machine can become "the shell", take over the pane and
answer the verbs — with fabricated screenshots and eval verdicts included. That
is the same trust boundary `/ws` already has, and `/ws` carries `run_command`, so
it is in policy rather than a defect. It was nowhere in writing until a review
asked; it is here now, and it is the reason a per-session browser (card 201's
next step) should not widen it.

For the same reason the browser segment's rectangle travels
`POST /api/browser/viewport` instead of `ipcRenderer`: the React layout measures
its own placeholder and the server forwards the rectangle down the channel the
shell already holds. Only the shell's **own window** may post one — it is
identified by a marker the shell stamps on that window's user agent, because
reading `Electron/` is not enough (the browser this card was verified in is
itself an Electron app and claimed to be the shell).

## Running the checks

```bash
# the pure half: the fence policy, the filter list, the pane geometry
cd spectro-desktop && npm test

# the engine drift guard: the four eval semantics, the redirect fence, the
# adblock, capturePage and the per-session isolation, against the Electron this
# build ships
cd spectro-desktop && npm run guard
GUARD_BREAK=fence npm run guard     # and resolve | adblock | settle | pagectx |
                                    #     await | emulate | partition

# the whole chain live: a real pane, the real channel, the real tools
cd spectro-desktop && npx tsc
SPECTRO_LIVE_BROWSER=1 ./gradlew :spectro-server:test --tests '*BrowserLiveDriveTest*' \
  --rerun-tasks --no-build-cache
```

`npm run guard` and the live test need a display and an Electron install, so
neither runs in CI. The pure half does: `gate.yml` has a `desktop-gate` job,
which is the test runner card 200 section 7 said this card owed.

## What is not here

- **The replay sidecar** — `.browser.jsonl`, screenshot-referencing events and
  the scrubber — is card 204. The brand rule still binds the line: the browser
  does not ship in a release without a replay path.
- **Launch configurations** are card 202, and they are built: the app under test
  starts by name from the repository's own `.claude/launch.json` and the browser
  opens on it. `docs/LAUNCH.md`.
- **Tabs.** `tab_id` is on every schema and **still refused**, and card 218
  changed the reason rather than the answer. Card 201 recorded its meaning as
  "the per-session browser the owner asked for"; that work is done, and it did
  **not** turn `tab_id` into a session selector. An argument that could name a
  session would be a way for one agent to reach another session's page, cookies
  and logins — the exact thing card 218 was written to prevent. So the parameter
  means what it always looked like it meant, a second tab *inside* this session's
  browser, there is one page per session today, and an id is refused naming the
  id and the page. Dedicated tab verbs stay on card 201's "later" list along with
  `form_input`, `get_text` and `read_network`.
- **A browser for a replayed session.** A stored transcript has no live browser;
  opening one shows the frame and the sign.
