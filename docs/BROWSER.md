# The visible browser

What cards 201, 218 and 226 built, where it lives, and the things it
deliberately does not do. The engine decision underneath the desktop face is
card 200's and is not re-argued here; `docs/BROWSER-ENGINE.md` is its home.
Since card 226 there are TWO faces under one seam: the desktop pane this page
mostly describes, and the server-side headless Chrome of the web face, which
has its own section below.

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
  gives it an address, `#/session/{id}/browser`. This is the whole-surface
  state/replay door the operator opens BY HAND (card 241);
- the workspace's **browser panel** in the dock beside the chat (cards 219/228)
  — the surface the AGENT's actions reveal.

Both mount the same component with the same session id, and the shell keys its
views by that id, so the second door is a view and never a second instance. Only
one of them can be on screen at a time — they are two arms of one layout — and
whichever is showing posts the rectangle it reserved. `sessionBrowser.drift.test.ts`
holds that: two mounts, one `sessionId` expression.

The segment draws a frame with an address line; the page inside it is a real
Chromium view the shell lays over that rectangle.

The agent does not need the reader to open the surface first, and — card 241,
from the owner's field report — it may not steal the surface the reader chose
either. When a browser tool runs, the shell asks the app's page for a surface,
and the app reveals the DOCK PANEL browser: opens it if closed, raises it if
folded, at most once per run (an operator who closed the panel mid-run has
answered, and the app does not re-ask). No tab and no segment flips. The pane
itself goes on screen only when the app posts the rectangle a mounted surface
just measured — a driving verb paints nothing, so a hidden browser stays the
operator's decision while the agent keeps driving the page underneath (a
screenshot of a never-shown pane can honestly fail with "the pane has not
painted yet"). A real navigation of the app window (a reload) hides every pane;
the fresh page starts uncovered and the first hole to report brings the pane
back. **Exactly one pane is ever on screen**: a report for one session takes
every other session's pane off. Two native overlays stacked over one rectangle
is the failure a `div` could never make, and the operator would be watching the
top one while the agent drove the other.

**The desktop-only trade is REVERSED (card 226, owner's call).** Card 201
ratified "desktop face only" and the owner reversed it on 2026-08-14, in his
own words:

> "Mach auf dem Browser einen nativen Inlay-Browser. Ja, ich hatte einen iframe
> gesagt, aber es geht darum, dass integrale Funktionalität im Browser nicht
> testbar ist — ich muss jetzt immer die Desktop-App testen, wenn ich irgendein
> neues Feature sehen will."

The IFRAME stays dead — card 200 measured why (foreign sites refuse framing,
the same-origin policy kills `browser_eval` = 41 % of the measured calls, no
rasterisation) and nothing changed there. What serves the web face instead is
the road this product already walks elsewhere: **a real headless Chrome on the
server, driven over CDP, streamed into the page** — see "The web face" below.
Card 200 section 5 named the seam that made this cheap, and it held:
`dev.spectroscope.core.browser.BrowserFace` gained a second implementation
without a schema, a tier, a sentence or a sidecar byte changing.

## The web face: a headless Chrome on the server (card 226)

A reader on `spectro web` gets a browser too, since 2026-08-14: **a headless
Chrome the server spawns, one per session, driven over CDP** —
`dev.spectroscope.core.browser.headless`. The seven tools are unchanged; they
drive whichever face is live through the same `BrowserFace` seam, and card
204's sidecar records both faces identically (`HeadlessLiveDriveTest` pins the
epoch marker, the paired lines and the screenshot-by-reference against a real
Chrome).

**Isolation, card 218's rule on this engine.** Each session's Chrome runs on
its own `--user-data-dir`: cookie jar, localStorage, cache and credential
store all hang off that directory and two directories share none of it. The
directory name carries a fingerprint of the RAW session id (sanitising is
lossy — `ab/c` and `ab:c` flatten alike) and an opening counter, so a resumed
session gets a fresh browser, logged out, never the cookies of a run that
ended. The lifetime is the session's: closing the session **kills the whole
process tree and deletes the profile directory**. Card 221 taught this house
what an orphaned child costs, so the kill captures the descendants first,
fells every one of them, and the live test counts the survivors TWICE — zero,
settle, zero again. A JVM shutdown hook reaps whatever a dying server leaves.

**The fence on this face, honestly.** The entry check is the same
`NetFence` every browser-class tool runs. The hook half rides CDP's `Fetch`
domain, restricted to `resourceType: Document`, judging with the same
`NetFence` policy behind a 30-second resolver cache (`HeadlessFence`) — so the
top-level page, **every redirect hop of it, and every iframe** are judged
before Chrome dials, DNS answers included. The URLs judged there come out of
Chrome's own network stack already WHATWG-normalised, so the octal-spelling
divergence the register lists cannot reach this hook in disguise. What this
face does NOT do, promised rather than discovered: Subresources (scripts,
images, XHR) are not judged on this face — policing them over CDP costs a JVM
round trip per request, the structural cost card 200 section 4 measured, and a
promise the engine cannot keep is not made. That sentence is pinned by
`WebFaceFencePromiseTest` against `HeadlessBrowserFace.SUBRESOURCE_PROMISE`,
and the live drive measures both halves: the refused redirect hop names its
rule, and the unjudged subresource really loads with the fence never asked.
This is the `browse_page` precedent — the limit is in the tool's own docs, not
silently absent. The desktop pane's in-hook fence still judges every
subresource; that difference is the honest gap between the two engines. DNS
rebinding stays outside what either face can promise, for the same reason as
ever: neither is the one that dials. No filter list rides this face — a
navigate reply's `adblocked` count is honestly zero.

**Precedence (criterion 5): the desktop wins.** One browser per session, never
two engines racing. `PrecedenceBrowserFaces` resolves per call: a desktop
shell holding `/ws/browser` serves every session; without one, the headless
engine serves. A shell ATTACHING kills every headless Chrome on the spot —
a Chrome kept running behind the pane the operator now watches would be an
orphan holding a cookie jar. A shell detaching flips back; the next verb opens
a fresh headless browser, logged out, exactly like a resume. `live()` answers
`"desktop"`, `"web"` or `"none"`, and the picture channel below pushes that
state to every watcher on either flip, so the web segment can always say whose
browser is live.

**The picture channel: `/ws/browser-view`.** The web segment watches the
headless browser here and drives it by hand — the parity of clicking inside
the desktop pane. Since card 227 the channel carries the operator's controls
on BOTH faces: the NAVIGATION verbs (`navigate`, `back`, `forward`, the start
page's play) run on whichever face is live, desktop pane included — the
desktop face's control row is React above the native hole, and its verbs
travel here to the SAME per-session browser the agent drives. `input` stays
web-face-only (on the desktop face the operator's hand is on the real pane; a
second synthetic driver is the race the one-browser rule exists to prevent),
and `screenshot` is read-only and serves both faces, handing the bytes back
as verb fields where the desktop face has no client-side picture to save.
Frames are CDP's own `Page.startScreencast` (jpeg, quality
60, capped 1280x800), acked frame-by-frame by the face itself. **Measured on
this machine (Chrome 151, 2026-08-14) before choosing:** screencast delivered
277 frames/3.0 s (~92 fps, ~6.3 KB/frame) on an animating page and sends
nothing when nothing paints; `Page.captureScreenshot` polling managed 41
shots/s at ~6.8 KB with a 25 ms median round trip per shot and burns that trip
even on a still page. Screencast is push, cheaper per frame and silent at
idle, so screencast it is; polling remains the fallback if it ever proves
unstable, and this paragraph is where to write that down.

The wire, client → server (`sessionId` is the session's store id, argument
names are `browser_computer`'s own so UI and tools speak one dialect):

```
{"type":"watch","sessionId":s}      subscribe; a state frame answers, and the
                                    cast starts if that session has a page open
{"type":"unwatch"}                  stop watching
{"type":"navigate","sessionId":s,"url":u}
{"type":"back","sessionId":s}       {"type":"forward","sessionId":s}
{"type":"reload","sessionId":s}     card 344: a RELOAD, carrying no address
{"type":"close_page","sessionId":s} card 346: drop the page, keep the cookies
{"type":"screenshot","sessionId":s}
{"type":"input","sessionId":s,"action":a,"coordinate":[x,y],"ref":r,
 "text":t,"scroll_direction":d,"scroll_amount":n,"duration":sec}
{"type":"launch_list","sessionId":s}           the start page's data (card 227)
{"type":"launch_play","sessionId":s,"name":n}  start a configuration, open it
{"type":"launch_save","sessionId":s,"entry":{"name","runtimeExecutable"?,
 "runtimeArgs","port"?,"url"?}}                card 352: add a configuration
```

Server → client:

```
{"type":"state","sessionId":s,"live":"desktop"|"web"|"none",
 "url":string|null,"attached":bool,
 "canGoBack":bool|null,"canGoForward":bool|null}
{"type":"frame","sessionId":s,"format":"jpeg","dataBase64":...,
 "deviceWidth":n,"deviceHeight":n,"ts":n}
{"type":"verb","verb":...,"ok":bool,"error"?,"url"?,"title"?,"detail"?,...}
{"type":"refused","sentence":...}   a fence refusal, the desktop being live
                                    for input, or an agent call in flight
{"type":"error","sentence":...}
{"type":"launch_configs","sessionId":s,"ok":bool,"sentence"?,
 "configs":[{"name","address","attaches","up","exitCode"?}],"skipped":n}
{"type":"launch_played","sessionId":s,"name":n,"ok":bool,"up":bool,
 "url"?,"sentence"?}
{"type":"launch_saved","sessionId":s,"ok":bool,"location"?,"sentence"?}
```

Watching an idle session never spawns a Chrome (`hasPage()` is asked first);
a `navigate` through this channel runs the entry fence before any engine is
spawned, and a refusal comes back as its own `refused` frame so the segment
can show the fence's sentence where the address was typed. One viewer per
session — the newest wins, the shell rule again. An agent-driven navigation
mid-watch is announced to the UI by the session's own `browser_action`
RunEvents; re-issuing `watch` restarts the cast on the new page.

**What the toolbar is told, and what it is not (card 344).** `reload` is a
reload: it carries no address, and both engines answer it with Chromium's own
reload rather than a fresh load of the remembered one — re-loading an address
loses what was typed into a form and re-posts what was posted, the objection
the desktop shell already states in writing for back/forward.

`canGoBack` and `canGoForward` are BOXED on this wire, and the third state is
the design. `null` means "this face cannot answer freshly" and never disables
a control. Only the web face answers: its engine reports every main-frame
navigation back up this channel, so a SIXTH state frame is pushed whenever the
page moves by itself, and the two booleans are exactly as fresh as the address
beside them. The desktop shell pushes no navigation, so its answer is `null`
rather than a cache that goes stale the moment the operator clicks a link on
the real pane — a stale `false` is a dead button over a working page, which is
worse than the error sentence it would replace.

**Which frame carries the address.** The state frame, and only it. A verb's
answer names an address exactly when the verb itself knows where it landed —
`navigate`, `back`, `forward` and `reload` each put it in their value. A
back-fill from the reply's own `pageUrl` filled that field in for any answer
that had none, and it was taken out because it could not close the case for
`input`, whose value has one key, `detail`: `Input.dispatchMouseEvent` returns
as soon as the event is dispatched and the navigation follows, so that address
is the page the click LEFT, not the page it reached. Worse, the client applies
any verb url it receives, so a stale one could undo the sixth state frame that
does follow the page. A click that moves the page is answered by that state
frame, not by the click.

The back-fill reached a second verb, and an earlier draft of this paragraph
said it reached only `input`. `screenshot` answers with an image and no url on
a page whose address the face knows, so both of the back-fill's conditions held
for it too: **a screenshot answer used to name an address and no longer does.**
On the web face that costs nothing — its address follows the page on state
frames. On the desktop face a screenshot was one of the occasions that
refreshed the segment's address line, because the client applies a verb url
into its state and that line prefers a state url over the status poll behind
it; what is lost is the occasion, not the address, since the poll reads the
same server-side cache the reply would have quoted. `close_page` answers with a
null `pageUrl`, so the back-fill never fired for it.

**Closing a page keeps the login (card 346).** `close_page` drops the view and
leaves the Chromium partition, its storage and its cache alone — the owner's
call, 2026-08-30: closing a tab in a real browser does not sign you out. A
navigate afterwards walks back into the same sessions. `close_session` is the
destructive neighbour and is unchanged. Two things this verb needs that a
reply cannot carry: the page is DROPPED rather than hidden (a hidden page keeps
its timers and its websockets behind a word that says it is gone), and the
server clears its own per-session address cache explicitly, because
`BrowserControlSocket` writes that cache from a reply's `pageUrl` and only when
that field is non-null — so the shell has no way to say "there is no page now".
With `url` back to null, both faces render the start page again, which is the
other half of what the owner asked for.

**The fight rule (card 227).** While an AGENT browser call is in flight for a
session — counted on the recording seam itself, from `open` to `end` — every
operator driving verb (`navigate`, `back`, `forward`, `input`, play) answers
one terse `refused` sentence instead of interleaving; between calls the
operator drives freely — and `reload` and `close_page` are driving verbs, so
they are gated too: one moves the page, the other takes it away from under a
call that is mid-flight. `screenshot`, watching and `launch_list` pass — they
race nothing. Every operator NAVIGATION is recorded through the session's own
`.browser.jsonl` recorder (same file, same epoch as the agent's calls) with
the additive `actor:"operator"` field; operator `input` is deliberately not
recorded — a sidecar logging every human keystroke would be a keylogger, not
a trace.

**The start page (card 227).** The empty browser segment on both faces lists
the session's launch configurations (card 202) over `launch_list`, one row
per configuration with its address and a play button. `launch_play` starts
the named configuration through the SESSION's own supervisor — what it starts
dies with the session, card 202's lifetime rule — then points the session's
browser at its address, fenced and recorded as the operator's navigation.
Card 202's split holds here too: a fence refusal answers `up:true, ok:false`
with the fence's own sentence, because the server came up and only the page
stayed away.

**Every press is on the record (card 337).** A launch that failed used to be a
`launch_played` frame and nothing else — it never became a `RunEvent`, so the
work panel, the trace, the export and the session's own file all learned
nothing, and the sentence died in a React `useState` on the next click. Every
outcome of the play button now also emits a `launch_outcome` event down the
ordinary file-then-socket road and closes a `launch_play` call in
`.browser.jsonl` as the operator's. A SUCCESS emits one too: a record carrying
only failures teaches its reader that silence means nothing happened. `url` and
`problem` are redacted whole by `Redaction`'s rules, like `browser_action`'s
url — every failure sentence on this path names the address it was waiting on.

**Writing one (card 352).** `launch_save` adds a configuration through
`LaunchWriter`, always to `.spectro/launch.json` — read theirs, write ours.
The entries already in the file are read here and the new one appended, because
the writer replaces the whole file and a save carrying one entry would delete
every other configuration the project has. Two refusals are worth naming: a
project whose configurations come from `.claude/launch.json` is refused with a
sentence naming that file and its entries, because writing ours would take
precedence and hide them while copying theirs into ours would hand the operator
somebody else's configurations under his own filename; and every write-time
guard of `LaunchWriter` arrives as the operator's own sentence rather than a
log line. The pen is the OPERATOR's — whether an AGENT may author one is card
352's criterion 1 and the owner has not answered, so no tool reaches this road
(`ClaudeFolderStaysTheirsDriftTest` pins it transitively) and the agent's
generic `write_file`/`edit_file` refuse either launch-file path by name rather
than by omission.

**What `/ws/browser-view` trusts** is exactly what `/ws` and `/ws/browser`
trust: loopback plus an accepted Origin, nothing more. Input carries no
permission gate, deliberately — it is the operator's own hand, the same trust
as clicking inside the desktop pane; `launch_play` runs what the project's own
launch file names, the same trust as typing into the app's terminal.
`back`/`forward` are the operator's verbs on either face (the headless face
walks `Page.getNavigationHistory`, the pane walks Chromium's
`navigationHistory`); the seven agent tools do not grow them.

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
   PrecedenceBrowserFaces.forSession(id)      card 226: which FACE is live,
              │                                resolved per call — the desktop
              │                                wins whenever its shell holds
              │                                the channel
      ┌───────┴────────────────────┐
      ▼ (shell attached)           ▼ (no shell)
BrowserControlSocket          HeadlessBrowserFaces (spectro-core)
  /ws/browser, one shell        one headless Chrome PER session,
  at a time, every send on      own profile dir, killed as a TREE
  a deadline and carrying       when the session closes
  its sessionId                      │ CDP over loopback
      │                              ▼
      ▼  (the MAIN process      HeadlessBrowserFace ──► BrowserViewSocket
       dialled IN)                                       /ws/browser-view:
browserControl.ts ──►                                    screencast frames out,
browserPane.ts                                           input + navigate in —
      │                                                  the web segment's wire
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

## The record: `.browser.jsonl` (card 204)

Watching live is half the promise. Every browser tool call is also recorded,
beside the session rather than in it:

```
~/.spectro/browser-wire/<session-id>.browser.jsonl
```

Two lines per call, paired by `cid`. The `browser_call` line is written the
moment the tool is entered — before there is any outcome, so a navigate into a
page that hangs is still on record — and `browser_result` closes it. A
`browser_open` marker stands at the head of each **epoch**: a session can outlive
its browser (closing the session retires it, a resume opens a fresh one with
fresh cookies), and both append here, so a replay that could not tell them apart
would narrate two logins as one story.

**Who drove (card 227):** an operator's own navigation — a typed address,
back, forward, the start page's play — records in the same file under the same
epoch with one additive field, `actor:"operator"`, and no `agentId`. An
agent's line carries no `actor` at all, so every sidecar written before this
card keeps its exact shape and absent reads as "agent" — which for those files
is simply true. A replay must never attribute a human's click to the model;
this field is what makes that a property of the record rather than a hope.

Each call also emits an additive `browser_action` RunEvent into the session
itself — metadata only, carrying the `cid` that joins the line to the record and
the `sha256` that joins it to the screenshot. The byte-frozen RunEvent wire grows
a new type and no existing event changes.

**What the record carries is only what the model already saw:** the arguments,
the result string, the address, and a *reference* to a screenshot blob. Cookies,
page storage and the credentials the page holds are not filtered out of it — they
never cross the recording seam, because `BrowserWireTap` takes no
`BrowserFace.Reply` in any signature. Every recorded string passes the same
`Redaction` rule table the state sidecar uses; a credential-shaped string is
replaced **whole** with a marker naming the rule and a size **band** rather than
an exact length, which is card 184's open finding answered instead of inherited.

Screenshots are references, never bytes: the blob lives in the `ImageStore` and
the record names it. That is what keeps a thousand-action run a text file.
Measured on the card-204 integration run (a real Chromium pane, four actions —
navigate, eval, screenshot, a refused navigate):

| | |
|---|---|
| the sidecar | **2,429 bytes**, 9 lines, ~600 bytes per action |
| the one screenshot blob | **7,828 bytes**, in the store, referenced once |
| the ledger read back | **3–7 ms** over loopback, five runs |
| the blob read back | **3.5 ms** |

The blob for a single screenshot is three times the whole text record of the run
that produced it, which is the arithmetic the stress test warned about: at a PNG
per action inline, the measured real traffic (3,447 calls) would be tens of
megabytes of JSONL. By reference it is roughly 60 KB of text per session at the
measured ~98 calls per session, and the pictures dedupe in the store.

    ./gradlew :spectro-server:test --tests '*BrowserLiveDriveTest*' \
        --rerun-tasks --no-build-cache   # with SPECTRO_LIVE_BROWSER=1

Served back through one gated, loopback-fenced endpoint per session, in the
`LlmWireController` shape:

| | |
|---|---|
| `GET /api/sessions/{id}/browser-wire` | the whole file, as an NDJSON download |
| `GET /api/sessions/{id}/browser-wire/index` | the bodiless ledger the scrubber walks |
| `GET /api/sessions/{id}/browser-wire/action/{cid}` | one action's two lines |

The id becomes a file name, so it wears the same shape check the session export
does — nothing with a slash, a dot or a `..` reaches the file system, and a
malformed `cid` answers 400 before the file is opened. Deleting a session deletes
its browser record with it.

The **replay view** is the session's own `browser` tab when the shown session is
a stored one: a scrubber over that session's trace, loading exactly the sidecar
and the blobs its steps reference. The stage holds the last screenshot while
later steps take none — the measured run shape is one navigate, one screenshot,
then a run of evals — and says so in words and by dimming, because showing a
later picture at an earlier step would be a claim about a moment nobody
photographed.

**Live frames never enter any of this.** The pixels the operator watches are a
native `WebContentsView` driven over `/ws/browser`; that protocol's verbs are
pinned out of the RunEvent union by `wireOnly.drift.test.ts`, so no control
reply — least of all `screenshot`'s base64 — can ever be appended to a session
file.

## What is not here

- **The replay sidecar** is card 204, and it is built: a `.browser.jsonl`
  beside the session, screenshot-referencing events, and a scrubber over a
  finished run. The rule the line was written under is therefore satisfied,
  that a surface you can watch must not be one you can only witness once.
- **Launch configurations** are card 202, and they are built: the app under test
  starts by name from the repository's own `.claude/launch.json`. The browser
  opens on it **once loopback is opted into** — a launch configuration almost
  always names localhost, and the net fence above refuses localhost until
  `allowLocalhost` is set, so out of the box the app starts and no page is
  opened. The answer says which of the two happened. `docs/LAUNCH.md`. Since
  card 227 the browser's own empty state lists them — the start page above.
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
- **A browser for a replayed session.** A stored transcript has no live browser.
  Its `browser` tab shows the **replay** instead (card 204, above); the rail's
  Browser segment stays live, because it is the view onto the CURRENT session's
  browser rather than onto whichever run is being read.
