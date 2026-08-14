# Headless and MCP — what an unattended run is allowed to reach

**Status: proposed. Nothing here is built.** This document is the decision
material for card 220. It names four roads, measures what each one costs,
recommends one and says out loud what the recommendation gives up. The owner
picks; the implementation story then cites the sections below instead of
re-deciding them.

Everything measured here was measured against `d83c101` on 2026-08-13, on a
Mac with an M-series CPU, with the JDK the Gradle build uses (Temurin 21.0.12),
against LM Studio serving `qwen/qwen3-coder-next`. Every number carries the
command that produced it — and, where the number is a duration, the round count
it was taken over, because a single wall time on this stack measures a cold
cache more often than it measures the thing under test (§2 was wrong about
exactly this once already).

---

## 1. What is actually true today

### 1.1 Four faces, three of them mount

`McpServerRegistry.load(...)` has three production call sites that mount, plus
an empty-list field initialiser; the headless face is not among any of them.
Run the grep and you get four hits under `main/`, which is why the count is
spelled out here rather than left to be recounted:

```
grep -rn "McpServerRegistry.load" --include="*.java" . | grep -v /test/
```

| face | call site | what it does |
|---|---|---|
| REPL | `spectro-cli/.../SpectroCli.java:468` | mounts every configured server for the session |
| doctor | `spectro-cli/.../DoctorCommand.java:304` | probes each server, prints reachability, closes in a `finally` at `:315` |
| web session | `spectro-server/.../session/SessionConnection.java:1045` | mounts per connection |
| — | `SpectroCli.java:153` | field initialiser over `List.of()`; an empty registry so the field is never null, mounts nothing |
| `spectro run` / cron / fleet node | — | **no call, and no tool registry at all** |

`RunCommand.java` contains no occurrence of `ToolRegistry`, `Mcp`,
`StandardTools` or `mcpServers`:

```
grep -n "ToolRegistry\|Mcp\|StandardTools\|mcpServers" \
  spectro-cli/src/main/java/dev/spectroscope/cli/RunCommand.java   # no output
```

The belt is minted inside the core instead, at
`spectro-core/.../scheduler/HeadlessRunner.java:240`, and the line still reads:

```java
ToolRegistry registry = new ToolRegistry(); // standard tools only — never the spawn tools
```

That runner is also the one behind `CronCommand`, `NodeCommand`,
`TriggeredNode` and `CronScheduler`, so every scheduled fire and every
triggered fleet node has the same belt as `spectro run`.

### 1.2 The contradiction, measured on the wire rather than asked of a model

The card reproduced the gap by asking a model what tools it had. That answer
depends on the model. The llm-wire record (card 184) does not: it holds the
verbatim request body, so the `tools` array is what the run really sent.

One settings file, one MCP server (the bundled `spectro-mcp-notes`), one
temporary home, three faces, the same minute:

```
export SPECTRO_OPTS="-Duser.home=<temp home>"           # never the owner's ~
spectro doctor
spectro --base-url <lm studio> run  -p "Reply with the single word: ok" --max-turns 1
printf 'Reply with the single word: ok\n/exit\n' | spectro --base-url <lm studio> repl
# then read tools[] out of ~/.spectro/llm-wire/<session>.llm.jsonl
```

| face | result |
|---|---|
| doctor | `✓ mcp: notes reachable at …/spectro-mcp-notes (2 tools)` |
| REPL wire | **22 tools with 0 skills installed** (23 with any skill), including `mcp__notes__search_notes` and `mcp__notes__add_note` |
| `spectro run` wire | **9 tools**, no `mcp__` entry at all |

The REPL number carries a precondition, so it is written next to it: `use_skill`
is registered only `if (!skills.skills().isEmpty())` (`SpectroCli.java:461`, and
identically `SessionConnection.java:1038`). The temporary home used here had
none, and the wire shows 22 with no `use_skill` in the array. Install one skill
and it is 23. The argument below does not turn on which.

The nine are exactly `StandardTools.all()` — `list_dir`, `read_file`,
`write_file`, `run_command`, `edit_file`, `glob`, `grep`, `view_image`,
`view_file` (`StandardTools.java:61-62`).

### 1.3 The finding the card does not have: headless is not "REPL minus MCP"

The REPL sends 22 tools with no skill installed and headless sends 9. Two of
the missing thirteen are the MCP pair. The other eleven are `browse_page`,
`web_search`, `web_fetch`, `generate_image`, `update_plan`, `spawn_agent`,
`spawn_agents`, `build_plan`, `write_spec`, `develop` and `test`. Install any
skill and `use_skill` joins them: 23 sent, fourteen missing, twelve of them not
MCP.

So the comment at `HeadlessRunner.java:240` understates its own boundary. It
names the spawn tools; the belt actually declines every tool that leaves the
path sandbox — all three network-egress tools, the image generator, and the
skill loader whenever one exists to load — and keeps a filesystem-and-shell set.
Headless is a deliberately small belt with a shape, not a full agent with two
omissions.

That cuts against mounting: an MCP server is arbitrary reach of unknown kind,
which is the category headless already excludes eleven times over.

### 1.4 And the finding that cuts the other way: what headless ignores from the settings file

`HeadlessRunner` reads exactly three config keys directly —
`config.provider()` (`:287`), `config.thinking()` (`:290`) and `config.hooks()`
(`:303`); the rest of the provider settings arrive through `ProviderFactory`.

```
grep -n "config\.\w*(" spectro-core/src/main/java/dev/spectroscope/core/scheduler/HeadlessRunner.java
```

Of everything an operator can write into `settings.json`, headless honours
provider, model, base URL, thinking, workspace and — as of today — hooks. It
ignores exactly two things:

- `permissionMode` / `autoApprove`, ignored **with a written reason** in the
  comment block at `HeadlessRunner.java:256-268`;
- `mcpServers`, ignored with **no reason written anywhere**.

The eleven tools of §1.3 are declined in code, identically for every operator,
and nobody declared them in a file and got silence. `mcpServers` is the last
thing an operator declares that a headless run reads past without a word.

### 1.5 Card 199 landed, and it did not give headless a fence

The card was written while card 199 was in progress and assumed the tier map
might arrive as a gate. It arrived as a **record**. The comment now standing at
`HeadlessRunner.java:256-268` says it plainly: headless never consults the
allowlist, so it has no wildcard to widen and no tier to enforce; what card 199
added is that every call lands in the gate audit sidecar with the tier it
resolved to and the map version that said so.

`McpToolTierGateTest` pins what the map can and cannot do: under MCP revision
`2024-11-05` a server's descriptors carry name, description and input schema
and nothing else, so a reader tool and a Node-context eval arrive
indistinguishable, both with `needsPermission() == true`. A tiered wildcard
(`mcp__playwright__*#read`) separates them **for an allowlist** — and headless
does not consult one.

So the fence card 220 hoped to inherit does not exist on this surface. After
any mounting road, `--permissions auto` is still the whole policy
(`HeadlessRunner.java:273`), and the tier is written down after the fact rather
than consulted before.

---

## 2. What a stdio server costs — measured, not asserted

The card recorded this as an honest unknown. It is now known.

The harness calls the same `McpServerRegistry.load(servers, cwd)` the REPL and
doctor call, with the real `McpTransports` default factory, and times process
spawn plus the `initialize` handshake plus `tools/list`, then `close()`. Run on
JDK 21 against the CLI's `installDist` classpath:

```
./gradlew :spectro-mcp-notes:installDist :spectro-cli:installDist
javac -cp <spectro-cli/build/install/spectro/lib/*> McpCost.java
java  -cp <same>:<classes> McpCost <name> <command> [args…]
```

| server | tools | load (min / median / max) | close |
|---|---|---|---|
| `spectro-mcp-notes` (JVM stdio, 5 rounds) | 2 | 123 / **144** / 551 ms | 2–10 ms |
| `chrome-devtools-mcp` via `npx` (3 rounds) | 29 | 953 / **1025** / 2359 ms | 11 ms |
| command that does not exist (3 rounds) | 0 | 3 / 3 / 156 ms | 0 ms |

The first round of each is the cold one; the JVM server's 551 ms and the npx
server's 2359 ms are first-round figures with a cold page cache.

#### What it is a cost *against*: a warm headless run is 1.4 s

An earlier draft of this section put the one-word `spectro run` at **18.3 s
wall** and concluded from it that a headless run is dominated by the model, so
the mounting cost only matters on an empty fire. **That figure was a cold-start
artifact and the conclusion drawn from it was wrong.** It was one unrepeated
round against a backend that had been idle, and what it timed was mostly LM
Studio loading the model. This section had already written down the rule it then
broke, one paragraph up: *the first round of each is the cold one.*

Re-measured, same prompt, same `--max-turns 1`, same model, same LM Studio, same
temporary home, six consecutive rounds after a first run in a fresh home at
2.63 s:

```
export SPECTRO_OPTS="-Duser.home=<temp home>"           # never the owner's ~
spectro --base-url <lm studio> run -p "Reply with the single word: ok" --max-turns 1
```

| what | rounds | measured |
|---|---|---|
| warm one-word `spectro run`, wall | 6 | 1.38 / **1.42** / 1.46 s (min / median / max) |
| JVM + CLI start alone (`spectro --version`) | 4 | 0.27 / 0.28 / 0.31 s |
| the same prompt by `curl` to the same backend, warm | 4 | 0.49 s (0.49 / 0.49 / 0.49 after a 1.21 s first) |

So a warm short fire is **1.4 s**, and the model is roughly a third of it: about
0.3 s is JVM and CLI start, about 0.5 s is the provider, and the remainder is
config, session store, agent loop and event writing. Nothing dominates.

**Read that in both directions, which is the point.** Mounting one `npx` server
at a median of 1025 ms roughly **doubles** a short fire. The bundled JVM server
at a median of 144 ms adds about **10 %**. The card's original framing — "a two second
`spectro run`" — was right, and the cost argument survives on the typical short
fire, not only on the empty one. That does not move the recommendation; it
strengthens it, because the road being recommended is the one that does not make
every fire pay.

### 2.1 The defect that gated every road: a mute server hung the JVM forever

A server whose command does not exist fails in 3 ms. A server that **spawns and
then never answers** did not fail at all.

**This section is history as of card 221**, "A silent MCP server hangs doctor
forever, and the timeout is the thing that hangs", which carries the reproduction
and the stack below verbatim and lands the fix with this paragraph. It gated all
four roads equally and so it chose between none of them (§4); what it leaves
behind is a *number* the roads have to carry, at the end of this section.

Everything above this heading was measured on 2026-08-13 against `d83c101`, and
so was the hang. The numbers for the fixed behaviour at the end of this section
were measured on 2026-08-14 against the branch that closes the card, on the same
machine.

`JsonRpcChannel` applied a per-request bound and the value is 20 s
(`StdioTransport.DEFAULT_READ_TIMEOUT`). On timeout it poisoned the channel —
`poison()` → `tearDown()` → `closeQuietly(in)` — on the comment's theory that
closing the stream unblocks the stuck `readLine`. It does not: `BufferedReader`
guards `readLine` and `close` with the same lock, the reader virtual thread holds
it while blocked in the native read, and `close()` waits behind it forever. The
timeout handler deadlocked against the read it existed to abandon, which is why
the 20 s bound was not merely exceeded but unreachable. Thread dump of the main
thread, taken with `jstack` after 30 s on the Gradle toolchain JDK (Temurin
21.0.12):

```
"main" … waiting on condition
  at jdk.internal.misc.InternalLock.lock(java.base@21.0.12/InternalLock.java:74)
  at java.io.BufferedReader.close(java.base@21.0.12/BufferedReader.java:619)
  at dev.spectroscope.core.mcp.JsonRpcChannel.closeQuietly(JsonRpcChannel.java:192)
  at dev.spectroscope.core.mcp.JsonRpcChannel.tearDown(JsonRpcChannel.java:181)
  at dev.spectroscope.core.mcp.JsonRpcChannel.poison(JsonRpcChannel.java:162)
  at dev.spectroscope.core.mcp.JsonRpcChannel.readLineWithTimeout(JsonRpcChannel.java:145)
  at dev.spectroscope.core.mcp.JsonRpcChannel.request(JsonRpcChannel.java:79)
  at dev.spectroscope.core.mcp.StdioTransport.initialize(StdioTransport.java:152)
  at dev.spectroscope.core.mcp.McpClient.start(McpClient.java:84)
  at dev.spectroscope.core.mcp.McpServerRegistry.load(McpServerRegistry.java:94)
```

Reproduced live on the shipped CLI, not only in the harness, and reproduced
again while closing this review. With
`{"mcpServers":{"mute":{"command":"/bin/sleep","args":["600"]}}}` in a
temporary home, `spectro doctor` printed every line up to
`✓ hooks: 0 configured`, reached the MCP probe and stopped. Still alive at 40 s
on JDK 21 and at 75 s on JDK 25; killed by hand in each case. Twenty seconds was
the documented bound and it was not the observed one on either.

**It is not a JDK 21 story, and an upgrade does not carry it away.** The eleven
frames from `DoctorCommand.call` down to `BufferedReader.close` are identical on
both; only the lock above them differs. On 21 the main thread parks on
`InternalLock` — a `ReentrantLock` — at `BufferedReader.java:619`. On 25 the same
call is `BLOCKED (on object monitor)` at `BufferedReader.java:526`, waiting to
lock the `InputStreamReader` itself. Two JDKs, two lock mechanisms, one
deadlock. Anyone reading the JDK 21 stack and reaching for a newer runtime as
the fix will find the hang waiting there too.

Four consequences, in order of who they hurt — and what card 221 did with each:

1. **It was a defect on doctor, on the REPL and on a web session**, with no road
   chosen and nothing implemented. The web face calls the same `load` at
   `SessionConnection.java:1045`, "connected once per socket" by its own comment,
   so a mute server parked a websocket connection the same way — the person
   watching saw a spinner rather than a hung terminal. **Closed** for all three:
   they enter at the same `McpServerRegistry.load` → `McpTransports.defaultFactory`
   funnel, and a test pins that funnel so a green probe cannot coexist with a
   production path that skips the teardown.
2. **Every mounting road inherited it as an unattended hang** — equally, which is
   why §4 refuses to use it to choose between them. A cron fire behind a server
   that starts and goes quiet never returned and never logged why. **Closed**: the
   probe now ends in bounded time and the row names the server and the exchange it
   went unanswered on.
3. Until card 221 landed, the cost table in §2 had no upper bound: mounting cost
   0.14–1.0 s in the good case and unbounded in the bad one, and the bad case is
   exactly the one an unattended fire cannot survive. **Closed, and this is the
   number the roads carry from here:** a server that spawns and never speaks costs
   **20 s of handshake budget plus a bounded shutdown tail of at most 5 s** — end
   of stream, a second's grace, `SIGTERM` the process tree, `SIGKILL` what ignored
   it, and a last grace for the reader to leave. **25 s is the worst case.**
   Measured on the fixed build, my own `installDist`, my own temporary home, two
   runs each: an ordinary silent server (`/bin/sleep 600`) **21.49 / 21.43 s**; a
   launcher that ignores `SIGTERM` (`/bin/sh -c "trap '' TERM; /bin/sleep 600;
   echo done"`) **23.43 / 23.47 s**; the same doctor with no MCP server configured
   **1.28 / 0.43 s**. Zero leftover processes after any of them.
4. **It also broke this card's own security criterion about leaked processes,
   before any road was chosen.** The card requires that a road which spawns
   servers refuses to leave them running. Measured then: the stalled server's
   child outlived the JVM — `/bin/sleep 600` was still there after the hung
   `doctor` was killed, because `StdioTransport` never reached its own teardown.
   **Closed, with one honest edge:** the teardown counts the process tree before it
   says goodbye and kills the census afterwards, so a server behind `npx`, `uvx` or
   a shell wrapper goes too. What no census can reach is a server whose launcher
   had already exited, or one forked after the count. §4.1's "the registry is
   closed on every exit path" is necessary, and card 221 is what makes it
   sufficient.

---

## 3. The roads

Each road below states what a headless run mounts, what `--permissions auto`
approves afterwards **in tool terms**, what cron and fleet nodes get, how the
doctor/run contradiction closes, and the failure it invites.

There are three shapes — always, on request, never — and the middle one has two
forms that differ in *where the operator asks*, so it is written out twice: B
asks on the command line, B′ asks in the settings file. They are not the same
road with a different syntax; they cost different things and they fail
differently.

### Road A — always mount

**What runs.** `HeadlessRunner` calls `McpServerRegistry.load(config.mcpServers(),
cwd)` next to `StandardTools.all()`, and closes it on every exit path including
the failure paths, the way `DoctorCommand.java:315` closes its probe.

**What `--permissions auto` approves afterwards.** Today: the nine tools of
`StandardTools.all()`, confined to the run's `cwd` path sandbox. Afterwards:
those nine plus **every tool every configured server advertises**, with no
sandbox that reaches inside the server. Concretely, with the
`chrome-devtools-mcp` entry the card was found against, `auto` approves 29
further tools including page navigation and script evaluation in a browser
context. Card 199 does not narrow this: headless does not consult the allowlist,
so the tier is recorded in the gate audit and never used to refuse (§1.5).

**Cron and fleet nodes.** Identical to `spectro run`, because they share the
runner. A cron line written before this change gains the whole server family on
its next fire, without the operator touching it.

**How the contradiction closes.** Completely and in the strong direction: what
doctor probes is what every face mounts, and `mcpServers` means one thing
everywhere.

**The failure it invites.** A settings edit changes what an already-registered
cron job may do, and nobody is watching the first fire that uses it. Plus the
per-fire cost of §2 on runs that never call a tool — roughly doubling a warm
short fire per `npx` server. §2.1's hang is **not** listed here: it was a
precondition for every road (§4), and a defect fixed before any road lands cannot
be a reason to prefer one road over another.

### Road B — mount on opt in

**What runs.** `spectro run --mcp` mounts every configured server; without the
flag the belt is what it is today. Cron jobs and fleet nodes carry the same
consent in their own spec (see §4.2) rather than inheriting a flag they cannot
type.

**What `--permissions auto` approves afterwards.** With no flag: unchanged —
the nine sandboxed tools. With `--mcp --permissions auto`: the nine plus every
tool of every configured server, exactly as Road A, and the help text must say
so in those words rather than describing the flag as "enable MCP tools".

**Cron and fleet nodes.** They take no flags, so the flag alone does not reach
them. They get an explicit per-job / per-node key; a job without it fires with
today's belt. §4.2 specifies it.

**How the contradiction closes.** In the other direction: doctor's line names
the faces its reachability applies to, so a reachable server no longer implies
a mounted one. §5 has the exact text.

**The failure it invites.** A fourth place where tool availability is decided,
and a fifth once cron has its own key — the scattering that made the card 199
allowlist hard to reason about. Worse, a script that forgets the flag gets
today's behaviour with no warning, which is the same shape of silence card 195
just closed for hooks.

### Road B′ — mount on opt in, declared once in the settings file

The same consent as Road B, asked for in a different place, and the difference
is the whole point: Road B's fifth decision site is self-inflicted by choosing
the command line first.

**What runs.** One settings key — `headlessMcp: true`, default false, next to
`mcpServers` — is honoured by **every** headless face: `spectro run`, a cron
fire and a triggered fleet node alike, because they share `HeadlessRunner` and
they all read the same config. Without it the belt is what it is today.

**What `--permissions auto` approves afterwards.** Identical to Road B: with the
key false, the nine sandboxed tools; with the key true, those nine plus every
tool of every configured server. The consent is the same consent; only the place
it is written moves.

**Cron and fleet nodes.** Covered by construction, with no second mechanism.
This is what B′ buys: cron lines and node specs take no flags, so Road B has to
grow them a per-job key (§4.2) that means the same thing as the flag and has to
be kept in step with it. B′ never opens that second place at all. A job written
before the change keeps today's belt until someone edits the settings.

**How the contradiction closes.** As in Road B: doctor's line names the faces
its reachability applies to (§5), with the tail reading `a headless run mounts
it only with headlessMcp` instead of `only with --mcp`.

**The failure it invites**, and it is a real one rather than a formality: **a
settings key is invisible at the call site.** With Road B, `spectro run --mcp`
in a cron line states that line's reach in the line itself — a person reading
`crontab -l`, or a job spec in review, sees what the fire can touch. With B′ the
same cron line reads exactly like a line that mounts nothing, and its reach lives
in a file somewhere else that a later edit can flip for **every** headless face
at once, including jobs registered long before. That is Road A's "capability
arrives without anyone typing anything" failure in slow motion: one edit, one
place, everything unattended widens together, and nothing at the call site
records it. Against that: it is one place to audit rather than three, and the
edit is at least an edit — nobody inherits it by upgrading.

### Road C — stay MCP free

**What runs.** Nothing changes in the code. `HeadlessRunner.java:240` keeps its
belt, and its comment is extended to say that MCP is refused too, and why.

**What `--permissions auto` approves afterwards.** Unchanged: the nine tools of
`StandardTools.all()` inside the run's path sandbox, and nothing an operator can
add to `settings.json` widens that. This is the only road under which the
sentence "an unattended run's reach is fixed at build time" is true.

**Cron and fleet nodes.** Identical to `spectro run` — a fire cannot reach a
tool server, ever, and that is the point.

**How the contradiction closes.** By doctor and the docs telling the truth:
doctor's line names its faces (§5), `INTEROP.md` names which faces mount, and
`.spectro/README-mcp.md` says the headless faces do not. The build stops
implying otherwise.

**The failure it invites.** We ship an agent runner whose unattended mode cannot
use the tool protocol the product advertises, and the answer to "can my cron job
use my MCP server" is no, permanently. It also leaves `mcpServers` as a settings
key that three faces read and three faces ignore, which is a shape this house
just spent a card removing for hooks.

---

## 4. Recommendation

**Take Road B — the flag form of opt in, with the flag naming what it approves —
and do Road C's honesty half immediately and unconditionally. The trade-off being
paid is real: an opt-in flag makes `mcpServers` the one settings key whose
meaning depends on which face reads it, it adds a fourth and then a fifth place
where tool availability is decided, and a cron line that forgets the key keeps
today's belt in silence, which is precisely the failure mode card 195 closed for
hooks earlier the same day.** That is the bill, and **§4.1 names the one road
that would cut it** — B′, the same consent declared once in the settings file,
which deletes the fifth decision site rather than paying for it. B is still
recommended over B′, on a single ground stated there.

The bill is paid because the constraint order on
the card puts permission above capability, and because §1.5 removed the fence
this card was written expecting: after any mounting road, `--permissions auto`
is the entire policy, the tier map is a record and not a gate, and an MCP server
under revision `2024-11-05` cannot tell a reader from an eval on the wire
(`McpToolTierGateTest`). Road A would hand that unfenced surface to every cron
job already registered, on its next fire, with no edit by the operator and
nobody watching. A capability that arrives without anyone typing anything is the
one thing an unattended runner must not grow.

**The hang is not a second argument against Road A, and this document is not
allowed to count it twice.** §2.1 was declared a precondition below — card 221
lands before any mounting road does, and it now has. A stalled server therefore
fails the same bounded way on every road, in the 25 s of §2.1, and it stops
separating A from B at all. What is left
separating them is the one thing that survives the fix: **Road A widens every
already-registered cron line with no operator edit, and B does not.** That
asymmetry carries the recommendation on its own, and it is the only part of it
that should.

Road C was the honest runner-up and lost on one point only: it makes
`mcpServers` permanently mean two different things, and this house has just
decided in the other direction for hooks. Road B keeps the capability reachable
for the operator who asks for it by name, which is what "the operator asked for
it either way" from the card 195 commit actually licenses — asking, not
inferring.

**Precondition, not a nicety — and it is met.** §2.1 was a live defect on doctor,
the REPL and a web session. It is **card 221**, and it had to land before any
mounting road did, because the moment `HeadlessRunner` mounts, a server that
starts and goes quiet would become a cron fire that never returns and never
explains itself. It has landed, with the bounded cost §2.1 now states. Card 220
carries 221 in its `blocked_by` for exactly this reason; discharging that entry is
a board decision and not this document's to take.

### 4.1 The flag, and why not the settings key

`--mcp`, all configured servers, no per-server form. A `--mcp <server>` variant
was considered and rejected here: it multiplies the surface without changing the
permission question, since the operator who names one server has still approved
that server's whole family. If the owner wants per-server *selection* it belongs
in the settings file next to `mcpServers`, not on the command line.

**Per-server selection and per-face consent are different questions, and Road B′
answers the second one in the settings file too.** That road is genuinely
cheaper on the recommendation's own bill: it removes the fifth decision site
before it exists, because one key covers `spectro run`, cron and nodes at once
and §4.2 never has to be written. The recommendation still takes B, on one
ground: **a cron line must state its own reach.** `spectro run --mcp` in a
crontab says what that fire can touch, in the line a person reads when they ask
what the machine is doing unattended. `headlessMcp: true` in a settings file
makes the identical cron line say nothing, and lets one edit widen every headless
face at once — including jobs registered months earlier by someone else. That is
the same shape as Road A's failure, slowed down by one deliberate edit, and this
card's constraint order puts permission above convenience.

If the owner weighs auditing-in-one-place above reading-reach-at-the-call-site,
B′ is the better road and the honest consequence is that §4.2 disappears and the
bill in §4 loses its "and then a fifth" clause. It is a real choice, not a
formality, which is why it is question 2 in §7 rather than a footnote.

- Help text, verbatim: `Mount the configured MCP servers. With --permissions
  auto this approves every tool every configured server offers, unwatched.`
- With `mcpServers` empty or absent: warn on stderr (`--mcp: no MCP servers
  configured`) and continue. Silence would let a typo in the settings path look
  like a working mount, and the run's stderr is the only place a cron fire's
  operator ever looks.
- A server that fails to start stays a visible skip on stderr
  (`McpServerRegistry.java:96`), never swallowed, so a silently absent tool is
  never mistaken for a refused one.
- The registry is closed on every exit path of the run including the failure
  paths, the way `DoctorCommand.java:315` closes its probe. A stdio child
  outliving a cron fire is a defect of this road, not a cost of it.

### 4.2 Cron fires and triggered nodes

They share `HeadlessRunner` and take no flags, so they need their own consent
and get it in the place the operator already writes: the job spec and the node
spec each grow a boolean `mcp` key, default **false**. A job written before the
change fires with today's belt, forever, until someone edits it.

This is the answer to the card's second open question, and it is deliberately
not "they follow the interactive run". A cron fire is the least observed thing
the product does; inheriting a default is exactly how it would grow reach nobody
chose.

**This whole section exists only under Road B.** Under B′ there is nothing here
to specify: the one settings key already reaches cron and nodes, because they
read the same config as `spectro run`. That is B′'s entire advantage, and it is
listed here rather than hidden so the size of the thing being declined is
visible next to the thing being chosen.

### 4.3 What stays out of scope

- The tier a mounted MCP tool holds is card 199's map, not this card's, and
  §1.5 records what that map does and does not do on this surface.
- The RunEvent wire is untouched. MCP calls already flow as ordinary
  `tool_call` / `tool_result`, which is what made card 198 possible.
- A run with no server configured must behave exactly as today, provably:
  `McpServerRegistry.load` over a null or empty list returns an empty registry
  (`:86`), and the existing headless suite must stay green unmodified.

---

## 5. Closing the contradiction — the exact texts

**AC 5 is answered here as a specification, not in the build.** The card asks
for the doctor/run contradiction to be closed in one of two directions; measured
today it is still open on the wire — doctor prints `✓ mcp: notes reachable …
(2 tools)` naming no face, and `spectro run` sends 9 tools. Closing it in the
build would mean writing code, and AC 8 forbids that. The two criteria cannot
both be satisfied, which is a conflict inside the card's own criteria rather than
something the spec chose. What is delivered is the exact replacement text, below,
so the implementation story types it rather than re-deciding it.

Under Road B, B′ or Road C, doctor's line must name the faces its reachability
applies to. Current text (`DoctorCommand.java:306-312`):

```
mcp: notes reachable at <target> (2 tools)
```

Replacement, Road B:

```
mcp: notes reachable at <target> (2 tools) — mounted by the repl and the web
     session; a headless run mounts it only with --mcp
```

Road B′ is the same line with the tail reading `only with headlessMcp in the
settings`. Road C drops the tail after the dash and reads `— mounted by the repl
and the web session, not by run/cron/node`.

Under Road A the doctor line needs no change: reachable would mean mounted
everywhere.

`docs/INTEROP.md` and `.spectro/README-mcp.md` have been corrected **now**, in
this change, only as far as is true under every road: they name which faces
mount today and point here for the pending decision. The road-dependent
sentence is written out above and lands with the implementation, never later
(card 220, AC 6).

---

## 6. The card 195 precedent, argued rather than cited

Card 195 merged on 2026-08-13 (`e84d4ce`, "Headless never ran the hooks it was
configured with"). Same runner, same class of gap: `HeadlessRunner` built its
agent with no `HookRunner`, so a blocking guard the settings file declared and
`spectro doctor` counted was inert in `spectro run`, in every cron job and in
every fleet node. It was closed by **always** wiring it — one builder call at
`HeadlessRunner.java:303` — not by a flag, and the commit's reasoning was that
a hook comes from config and never from model output, so it is exactly as
trustworthy headless as interactively, and the operator asked for it either way.

Read at the level of "what the operator declared in settings, the runner
honours", that precedent points straight at Road A, and §1.4 sharpens it:
`mcpServers` is now the *last* settings key a headless run reads past in
silence. That is the strongest argument on the other side of this
recommendation, and it is not a weak one.

It is not followed here because the two gaps are opposite in direction. A hook
can only ever **refuse** a call; wiring an inert refuser cannot widen what an
unattended run touches — the worst case of the hooks fix is a cron job that
stops doing something. An MCP server can only ever **add** reach; the worst case
of the same fix here is a cron job that starts doing something nobody chose, at
a tier no gate checks (§1.5). The constraint order on card 220 puts permission
before capability precisely for this asymmetry. §2.1 is deliberately not part of
this argument: it is a precondition for every road (§4), so it cannot also be a
reason to prefer one.

The honest residue: the precedent still wins the *documentation* half outright.
Whatever road is taken, a settings key that some faces honour and others ignore
must say so where it is documented, and it must say so in the same change that
decides it. That half is done here and is not waiting for the owner.

---

## 7. Open questions the owner must answer

1. **Which road: A, B, B′ or C.** Nothing below §3 is decided until this is.
   Everything else in this document is measurement. Recommended: **B**.
2. **If B or B′ — where the operator asks.** This is question 1 in a sharper
   form and it is the one real choice inside the recommendation: `--mcp` on the
   command line, so a cron line states its own reach and nothing else can widen
   it (B, recommended); or one `headlessMcp` settings key honoured by every
   headless face, so consent lives in one auditable place and §4.2 never has to
   exist (B′). §4.1 argues for B and names what B′ would save.
3. Whether cron fires and triggered nodes take §4.2's per-job key, or follow the
   interactive run. Recommended: their own key, default false. Moot under B′.
4. ~~Whether card 221 (the mute-server hang, §2.1) blocks a mounting road or
   ships as a parallel fix.~~ **Answered by events rather than by the owner: 221
   landed first.** The recommendation was that it blocks, and card 220 names it in
   `blocked_by`. It was the difference between a one-second cost and an unbounded
   one; the cost table in §2 now has the upper bound §2.1 states. Left on the list
   with its answer so nobody re-runs the reasoning.

## 8. Open questions this document deliberately leaves open

- The startup cost of an HTTP/SSE server was not measured; only stdio spawns a
  process, and the roads differ on process cost. An HTTP server's connect cost
  is bounded by `HttpSseTransport`'s 20 s timeout and has the same shape of
  question as §2.1. Card 221 went far enough to say it cannot deadlock the same
  way — there is no child process and no reader thread there, and `RestClient`
  bounds it — and left the connect cost itself unmeasured.
- Whether the eleven non-MCP tools of §1.3 should be reachable headless at all
  is a larger question than this card. It is named here because it changes how
  the MCP absence reads, and it is not answered here.
