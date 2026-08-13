# The visible browser

What card 201 built, where it lives, and the two things it deliberately does not
do. The engine decision underneath it is card 200's and is not re-argued here;
`docs/BROWSER-ENGINE.md` is its home.

## Where the pane lives

**A surface inside the spectroscope desktop app.** Open the app, and the rail
has a fourth segment under Sessions, Fleets and State graph: **Browser**. The
segment draws a frame with an address line; the page inside it is a real
Chromium view the shell lays over that rectangle.

The agent does not need the reader to open the segment first. When a browser
tool runs, the shell shows the pane and asks the app's page to switch to the
Browser segment, so the operator ends up looking at the page the agent is
driving. That is the whole point of the card: not a headless renderer that
posts screenshots, but a browser you watch.

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
| `browser_read_console` | read | what the page logged, plus what the fence refused |
| `browser_resize` | write | the viewport the page believes it has |

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
| in-hook fence | `browserFence.ts`, in `session.webRequest.onBeforeRequest` | the top-level navigation, **every redirect hop** and **every subresource** |

The second is the one `browse_page` never had. Its javadoc says so plainly:
"policing the browser's own traffic needs a proxy Chrome runs through, and that
is its own card". This engine needs neither.

Both halves read the same vector table,
`spectro-core/src/main/resources/browser/fence-vectors.json`, and both are tested
against it. Where they honestly differ the table carries a **divergence
register** and both sides assert their own column. The interesting row, measured
on 2026-08-13: Java's `InetAddress` reads `http://0177.0.0.1/` as the public
`177.0.0.1` and the entry check allows it, while Chromium reads octal loopback
and dials `127.0.0.1` — only the in-hook fence sees what was actually dialled.

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

## How it is wired

```
model ──► BrowserTools (spectro-core)         seven tools, schemas, tiers,
              │                                entry fence, image path
              ▼
         BrowserFace                          the seam card 200 section 5 asks for
              │
              ▼
    BrowserControlSocket (spectro-server)     /ws/browser, one shell at a time,
              │                                every send on a deadline
              ▼  (the MAIN process dialled IN)
      browserControl.ts ──► browserPane.ts    WebContentsView + the request hook
                                   │
                                   ▼
                              the pane the operator watches
```

The control channel points **from the shell to the server**, not the other way.
Card 200 section 9.3 left the shape open and recommended this one: the
alternative is a preload script plus `ipcMain`, and `navigationGuard.ts` names
"this shell has no preload script at all" as a security property rather than an
omission. A main-process client keeps it.

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
# adblock and capturePage, against the Electron this build ships
cd spectro-desktop && npm run guard
GUARD_BREAK=fence npm run guard     # and adblock | settle | pagectx | await

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
- **Launch configurations** are card 202.
- **Tabs.** `tab_id` is on every schema and reaches the shell; there is one pane
  behind it today. Dedicated tab verbs are on card 201's own "later" list along
  with `form_input`, `get_text` and `read_network`.
