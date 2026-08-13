# Headless and MCP — what an unattended run is allowed to reach

**Status: proposed. Nothing here is built.** This document is the decision
material for card 213. It names three roads, measures what each one costs,
recommends one and says out loud what the recommendation gives up. The owner
picks; the implementation story then cites the sections below instead of
re-deciding them.

Everything measured here was measured against `d83c101` on 2026-08-13, on a
Mac with an M-series CPU, with the JDK the Gradle build uses (Temurin 21.0.12),
against LM Studio serving `qwen/qwen3-coder-next`. Every number carries the
command that produced it.

---

## 1. What is actually true today

### 1.1 Four faces, three of them mount

`McpServerRegistry.load(...)` has four production call sites and the headless
one is not among them:

```
grep -rn "McpServerRegistry.load" --include="*.java" .
```

| face | call site | what it does |
|---|---|---|
| REPL | `spectro-cli/.../SpectroCli.java:468` | mounts every configured server for the session |
| doctor | `spectro-cli/.../DoctorCommand.java:304` | probes each server, prints reachability, closes in a `finally` at `:315` |
| web session | `spectro-server/.../session/SessionConnection.java:1045` | mounts per connection |
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
| REPL wire | **23 tools**, including `mcp__notes__search_notes` and `mcp__notes__add_note` |
| `spectro run` wire | **9 tools**, no `mcp__` entry at all |

The nine are exactly `StandardTools.all()` — `list_dir`, `read_file`,
`write_file`, `run_command`, `edit_file`, `glob`, `grep`, `view_image`,
`view_file` (`StandardTools.java:61-62`).

### 1.3 The finding the card does not have: headless is not "REPL minus MCP"

The REPL sends 23 tools and headless sends 9. Two of the missing fourteen are
the MCP pair. The other twelve are `browse_page`, `web_search`, `web_fetch`,
`generate_image`, `use_skill`, `update_plan`, `spawn_agent`, `spawn_agents`,
`build_plan`, `write_spec`, `develop` and `test`.

So the comment at `HeadlessRunner.java:240` understates its own boundary. It
names the spawn tools; the belt actually declines every tool that leaves the
path sandbox — all three network-egress tools, the image generator, the skill
loader — and keeps a filesystem-and-shell set. Headless is a deliberately small
belt with a shape, not a full agent with two omissions.

That cuts against mounting: an MCP server is arbitrary reach of unknown kind,
which is the category headless already excludes twelve times over.

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

The twelve tools of §1.3 are declined in code, identically for every operator,
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

So the fence card 213 hoped to inherit does not exist on this surface. After
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

**Read the number honestly in both directions.** One second per npx server per
fire is real money on a cron line that fires every minute and never calls a
tool. It is also small next to the run it would join: the one-word
`spectro run` measured above took **18.3 s wall** end to end against LM Studio.
The card's framing — "a two second `spectro run`" — did not survive contact
with a real backend; a headless run that calls a model is dominated by the
model. The cost argument is therefore about the *empty* fire, not about the
typical one.

### 2.1 The number that actually decides it: a mute server hangs the JVM forever

A server whose command does not exist fails in 3 ms. A server that **spawns and
then never answers** does not fail at all.

`JsonRpcChannel` bounds each request at 20 s (`:137`) and, on timeout, poisons
the channel — `poison()` (`:160`) → `tearDown()` (`:179`) → `closeQuietly(in)`
(`:181`) — on the comment's theory that closing the stream unblocks the stuck
`readLine`. On JDK 21 it does not. `BufferedReader` guards `readLine` and
`close` with the same `InternalLock`, the reader virtual thread holds it while
blocked in the native read, and `close()` parks behind it. Thread dump of the
main thread, taken with `jstack` after 30 s:

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

Reproduced live on the shipped CLI, not only in the harness. With
`{"mcpServers":{"mute":{"command":"/bin/sleep","args":["600"]}}}` in a
temporary home, `spectro doctor` printed every line up to
`✓ hooks: 0 configured`, reached the MCP probe and stopped. Killed at
**2 min 00 s**; the harness run before it was still parked past five minutes.
Twenty seconds is the documented bound and it is not the observed one.

Three consequences, in order of who they hurt:

1. **This is a defect today, on doctor and the REPL**, with no road chosen and
   nothing implemented. It belongs on its own card and should be fixed whether
   or not headless ever mounts.
2. **Every mounting road inherits it as an unattended hang.** A cron fire behind
   a server that starts and goes quiet never returns and never logs why. The
   card's security criterion "an unreachable server never fails the run into a
   different posture" is currently satisfied for a server that cannot start and
   violated for one that starts and stalls.
3. It resets the cost comparison. Mounting costs 0.14–1.0 s in the good case
   and unbounded in the bad one, and the bad case is exactly the one an
   unattended fire cannot survive.

---

## 3. The three roads

Each road below states what a headless run mounts, what `--permissions auto`
approves afterwards **in tool terms**, what cron and fleet nodes get, how the
doctor/run contradiction closes, and the failure it invites.

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
per-fire cost of §2 on runs that never call a tool, plus §2.1's hang landing in
the least observable place in the product.

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

**Take Road B, with the flag naming what it approves, and do Road C's honesty
half immediately and unconditionally — and the trade-off being paid is real: an
opt-in flag makes `mcpServers` the one settings key whose meaning depends on
which face reads it, it adds a fourth and then a fifth place where tool
availability is decided, and a cron line that forgets the key keeps today's
belt in silence, which is precisely the failure mode card 195 closed for hooks
earlier the same day.** That is the bill. It is paid because the constraint order on
the card puts permission above capability, and because §1.5 removed the fence
this card was written expecting: after any mounting road, `--permissions auto`
is the entire policy, the tier map is a record and not a gate, and an MCP server
under revision `2024-11-05` cannot tell a reader from an eval on the wire
(`McpToolTierGateTest`). Road A would hand that unfenced surface to every cron
job already registered, on its next fire, with no edit by the operator and
nobody watching — and §2.1 says one stalled server turns that fire into a
process that never returns. A capability that arrives without anyone typing
anything is the one thing an unattended runner must not grow.

Road C was the honest runner-up and lost on one point only: it makes
`mcpServers` permanently mean two different things, and this house has just
decided in the other direction for hooks. Road B keeps the capability reachable
for the operator who asks for it by name, which is what "the operator asked for
it either way" from the card 195 commit actually licenses — asking, not
inferring.

**Precondition, not a nicety.** §2.1 is a live defect on doctor and the REPL
today. It must be fixed on its own card before any mounting road lands, because
the moment `HeadlessRunner` mounts, a server that starts and goes quiet becomes
a cron fire that never returns and never explains itself.

### 4.1 The flag

`--mcp`, all configured servers, no per-server form. A `--mcp <server>` variant
was considered and rejected here: it multiplies the surface without changing the
permission question, since the operator who names one server has still approved
that server's whole family. If the owner wants per-server selection it belongs
in the settings file next to `mcpServers`, not on the command line.

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

Under Road B or Road C, doctor's line must name the faces its reachability
applies to. Current text (`DoctorCommand.java:306-312`):

```
mcp: notes reachable at <target> (2 tools)
```

Replacement, Road B and Road C:

```
mcp: notes reachable at <target> (2 tools) — mounted by the repl and the web
     session; a headless run mounts it only with --mcp
```

Road C drops the tail after the dash and reads `— mounted by the repl and the
web session, not by run/cron/node`.

Under Road A the doctor line needs no change: reachable would mean mounted
everywhere.

`docs/INTEROP.md` and `.spectro/README-mcp.md` have been corrected **now**, in
this change, only as far as is true under all three roads: they name which faces
mount today and point here for the pending decision. The road-dependent
sentence is written out above and lands with the implementation, never later
(card 213, AC 6).

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
a tier no gate checks (§1.5), in a process that may never return (§2.1). The
constraint order on card 213 puts permission before capability precisely for
this asymmetry.

The honest residue: the precedent still wins the *documentation* half outright.
Whatever road is taken, a settings key that some faces honour and others ignore
must say so where it is documented, and it must say so in the same change that
decides it. That half is done here and is not waiting for the owner.

---

## 7. Open questions the owner must answer

1. **Which road.** Nothing below §3 is decided until this is. Everything else in
   this document is measurement.
2. Whether cron fires and triggered nodes take §4.2's per-job key, or follow the
   interactive run. Recommended: their own key, default false.
3. Whether §2.1 (the mute-server hang) blocks a mounting road, or ships as a
   parallel fix. Recommended: it blocks — it is the difference between a
   one-second cost and an unbounded one.

## 8. Open questions this document deliberately leaves open

- The startup cost of an HTTP/SSE server was not measured; only stdio spawns a
  process, and the roads differ on process cost. An HTTP server's connect cost
  is bounded by `HttpSseTransport`'s 20 s timeout and has the same shape of
  question as §2.1.
- Whether the twelve non-MCP tools of §1.3 should be reachable headless at all
  is a larger question than this card. It is named here because it changes how
  the MCP absence reads, and it is not answered here.
