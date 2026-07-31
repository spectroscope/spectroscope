# Verifying a feature whose output comes from a model

How to tell "the code is broken" from "the model is too weak" in this repo,
without spending a release cycle on the wrong answer.

Recorded 2026-07-27, after both mistakes happened in the same week on the
event-level translation feature.

---

## The rule

**Rule out the model before you report a defect. Rule out the wiring before you
blame the model.**

In practice that is three steps, in this order:

1. Switch the provider to a capable model. Cloud models registered in the local
   ollama cost nothing on this machine, so there is no cost argument for
   verifying against the weak bundled one.
2. Probe the model's own competence with a one-line call before you judge the
   feature.
3. If the feature still fails, send the same request to our endpoint and to the
   provider's endpoint underneath it, several times each, and compare.

A weak model and a reasoning model break the same feature in opposite
directions. The weak one returns the input roughly unchanged. The reasoning one
returns nothing, because the answer went out the thinking channel. If you only
ever see one of those, you will misdiagnose the other.

### The failure that produced this document

The event-level translation feature was verified against the bundled local
model, a Qwen3 1.7B. It echoed the German reasoning back nearly unchanged: 410
characters in, 412 characters out. The written verdict was that "the reasoning
did NOT read in the target language in either live run, in any of the three
views", with a recommendation not to ship.

The wiring was correct. The model could not do the task. That verdict cost a
release cycle and came close to shipping a false "does not work" conclusion
about working code.

### The opposite failure, one step later

Switching to a capable model surfaced a real defect that the weak model had
been masking. See [LESSONS-TRANSLATION.md](LESSONS-TRANSLATION.md), section
"Never report an empty unit as finished", for that defect and its fix. So the
lesson is not "use a big model and relax". Both halves of the rule are load
bearing.

---

## Switching the provider for a verification run

### What actually wins

The full config hierarchy is already documented in
[ARCHITECTURE.md](ARCHITECTURE.md) section 3 ("Configuration: layers, `.env`,
and the launcher"). Read the diagram there rather than reconstructing it. The
one part that matters for verification, and that catches people:

**`SPECTRO_PROVIDER` and `SPECTRO_MODEL` lose against a persisted
`~/.spectro/settings.json`.** The env layer sits directly above the built-in
defaults, below every settings file. Setting the env var on a machine that has
a user settings file does nothing to the provider.

The chain is built and folded in
`spectro-core/src/main/java/dev/spectroscope/core/config/SpectroConfig.java:340-361`.
The scopes are appended in ascending precedence and folded in that order, so
the last one to supply a field wins:

```java
scopes.add(new Scope("env", PartialConfig.fromEnv(env)));                                  // :340
scopes.add(new Scope("user", readFile(CONFIG_PATH).overriddenBy(readFile(USER_SETTINGS_PATH)))); // :341
scopes.add(new Scope("launch-dir", readFile(projectDir.resolve(PROJECT_SETTINGS))));       // :342
// ... workspace project, workspace local (only when a workspace is resolved) ...
scopes.add(new Scope("flags", PartialConfig.fromOverrides(overrides)));                    // :353
```

Pinned by `SpectroConfigTest.environmentSitsBelowTheSettingsFiles`
(`spectro-core/src/test/java/dev/spectroscope/core/config/SpectroConfigTest.java:167-183`),
whose own assertion message reads "the project settings file beats the
environment".

The trap has a second half. `SpectroConfig.ensureSeeded`
(`SpectroConfig.java:411`) materializes the env layer into
`~/.spectro/settings.json` on first boot, and every entry point calls it:
`SpectroServerApplication.java:37`, `SpectroCli.java:181`,
`RunCommand.java:105`, `NodeCommand.java:340`, `DoctorCommand.java:116`. So a
fresh home does honour your env vars once, writes them to a file, and from the
second boot onward that file outranks the env. The variable that worked
yesterday is inert today, and nothing in the run output says so unless you ask.

### Ask what won, do not assume

`spectro doctor` names every `SPECTRO_*` variable that is set but shadowed
(`spectro-cli/src/main/java/dev/spectroscope/cli/DoctorCommand.java:173-178`).
Measured on this machine on 2026-07-27, with
`SPECTRO_PROVIDER=ollama SPECTRO_MODEL=glm-5.2:cloud ./spectro doctor`:

```
✓ config: provider=ollama model=kimi-k2.7-code:cloud permissionMode=ask autoApprove=0 rule(s)
  layers: user settings.json present · launch-dir settings.json (deprecated) absent
  env SPECTRO_PROVIDER is set but shadowed by user settings (effective provider comes from user)
  env SPECTRO_MODEL is set but shadowed by user settings (effective model comes from user)
```

The env vars were set to `glm-5.2:cloud` and the effective model was
`kimi-k2.7-code:cloud`. Doctor is the cheapest way to catch this; run it before
you trust a verification run's provider.

For a running server, `GET /api/settings` carries the same provenance per
field. Measured against the server on `:8080`:

```
effective provider/model: ollama / kimi-k2.7-code:cloud
origins.provider: {"winner": "user", "shadowed": []}
origins.model:    {"winner": "user", "shadowed": []}
files: {"user": "/Users/christopher.ezell/.spectro/settings.json", ...}
```

`origins.<field>.winner` is the answer to "which layer set this". If it says
`user` and you edited the env, your switch did not happen.

### Four ways to switch, and when each applies

| Way | Mechanism | Use it when |
|---|---|---|
| CLI flag | `--provider` / `--model` on the parent command (`spectro-cli/src/main/java/dev/spectroscope/cli/SpectroCli.java:86-92`) | Headless runs. Highest layer, beats every file. |
| User settings file | Edit `~/.spectro/settings.json`, or `PUT /api/settings/user` (`spectro-server/src/main/java/dev/spectroscope/server/SettingsController.java:143`) | Server verification runs, before boot. |
| The picker | `set_provider` over the WebSocket (`SessionConnection.onSetProvider`, `spectro-server/src/main/java/dev/spectroscope/server/SessionConnection.java:448`) | Browser verification. Applies on the next prompt, not retroactively. |
| Fresh home | `java -Duser.home=$T -jar …` with env vars set | First-run behaviour. No settings file exists yet, so env wins, once. |

Two gotchas measured on 2026-07-27:

**The `./spectro` launcher drops flags for some verbs.** Line 173 of `./spectro`
hardcodes `--args="doctor"`, so `./spectro doctor --model glm-5.2:cloud`
silently ignores the flag: the run reported `model=kimi-k2.7-code:cloud`. The
`run` and `node` verbs do forward their arguments (lines 165 and 166).

**Parent options must precede the subcommand.** Passed correctly, the flag wins
over the settings file:

```bash
./gradlew -q --console=plain :spectro-cli:run --args="--model glm-5.2:cloud doctor"
#   ✓ config: provider=ollama model=glm-5.2:cloud …
```

A blank model on a live switch resolves the target provider's own default and
never carries the previous provider's model
(`SessionConnection.java:465-477`). Name the model explicitly in a verification
run so the record says which one you tested.

---

## Probe the model before judging the feature

Before you conclude anything about the feature, spend one call finding out
whether the model can do the underlying task at all. Talk to ollama directly,
not through our stack, so the probe cannot be confounded by our code.

```python
# probe.py: does this model do the task at all?
import json, sys, urllib.request

MODEL = sys.argv[1]
GERMAN = ("Ich pruefe zuerst, welche Datei der Nutzer meint, und lese sie dann "
          "vollstaendig, bevor ich irgendetwas aendere.")
PROMPT = ("Translate the following German text to English. "
          "Reply with the translation only.\n\n" + GERMAN)

for i in range(1, int(sys.argv[2] if len(sys.argv) > 2 else 3) + 1):
    body = json.dumps({"model": MODEL, "stream": False,
                       "messages": [{"role": "user", "content": PROMPT}]}).encode()
    req = urllib.request.Request("http://localhost:11434/api/chat", data=body,
                                 headers={"Content-Type": "application/json"})
    out = json.load(urllib.request.urlopen(req, timeout=180))["message"]["content"]
    print(f"{MODEL} run {i}: {len(out)} chars | {out.strip()[:110]!r}")
```

`/api/chat` is the endpoint our own `OllamaProvider` posts to
(`spectro-core/src/main/java/dev/spectroscope/core/provider/OllamaProvider.java:298`),
so the probe exercises the same surface with none of our code in between.

Measured 2026-07-27, three runs each:

```
glm-5.2:cloud    run 1: 107 chars | 'First, I check which file the user is referring to, and then I read it completely before I change anything.'
glm-5.2:cloud    run 2: 104 chars | 'I first check which file the user is referring to, and then read it completely before changing anything.'
glm-5.2:cloud    run 3: 104 chars | 'I first check which file the user is referring to, and then read it completely before I change anything.'
deepseek-r1:32b  run 1:  98 chars | 'I first check which file the user refers to and then read it completely before making any changes.'
deepseek-r1:32b  run 2: 109 chars | 'I first verify which file the user is referring to and then read it entirely before making any modifications.'
```

Both models did the task, on every run, with stable output length. That
establishes the baseline: if the feature now returns nothing or returns the
German back, the model is not the reason.

Read the probe for two distinct failures:

- **Output resembles the input, and the length barely moves.** That is the weak
  model. The 410-in / 412-out reading was exactly this shape. Do not write a
  verdict about the feature from this run.
- **Output is empty or near-empty while the model clearly worked.** The answer
  went out the reasoning channel instead of the content field. This is a wiring
  question about which channel we read, not a competence question.

Models available on this machine at the time of writing:
`glm-5.2:cloud`, `kimi-k3:cloud`, `kimi-k2.7-code:cloud`, `qwen3.5:27b-q4_K_M`,
`qwen3.5:35b-a3b-q4_K_M`, `translategemma:27b`, `gpt-oss:20b`,
`deepseek-r1:32b`. Confirm with `curl -s localhost:11434/api/tags` rather than
trusting this list.

---

## Locating a defect by comparing layers

When the probe says the model is fine and the feature still fails, send the same
request to our endpoint and to the provider's endpoint beneath it, repeated
several times, and compare the output sizes.

The measurement that split the translation bug, same input throughout:

| Layer | Run 1 | Run 2 | Run 3 | Run 4 | Run 5 |
|---|---|---|---|---|---|
| our server | 0 | 0 | 16 | 0 | 242 |
| ollama `/api/chat` | 229 | 239 | 237 | | |

Characters of output. The provider was stable across runs. Our layer was not.
Non-determinism on our side against stability on the layer below located the
bug in our code, in one command, with no reading of the model's behaviour
required.

Both directions of that comparison carry information:

- **Ours varies, theirs is stable.** The defect is in our code. Race,
  buffering, an early close, a channel we read inconsistently.
- **Both vary the same way.** Model sampling. Not a defect. Pin a seed or
  temperature, or measure a property that does not depend on the exact tokens
  (did anything arrive at all, is it in the target language) instead of the
  tokens themselves.
- **Ours is consistently empty, theirs is consistently full.** Deterministic
  wiring bug. Cheapest kind to find, because it reproduces every time.

Repeat the run. A single sample cannot distinguish any of these from any other.
Five was enough here because the pattern was 0, 0, 16, 0, 242, but the number
of runs is not the point; seeing whether the numbers move is.

---

## A component's success signal is a claim, not evidence

One verification run reported total success while roughly a third of the work
had been silently dropped. The server closed every unit with `end:true`
regardless of whether that unit produced output, so the success signal was
structurally incapable of reporting failure.

Treat any component's own report of success as a claim to be checked. The
evidence is the counts:

- How many units went in, how many came out, and do those two numbers match.
- How many produced non-empty output.
- What is the size of each output, not just the total.

Sizes per unit matter because a total can hide a hole. Three units at 240
characters and four units at 0 sum to something that looks plausible next to a
single expected total.

Corollary for reading verdicts, including your own from an earlier session: a
verdict that says "did not work" without counts next to it has not been
measured. The 410 / 412 reading was a real measurement and still produced the
wrong conclusion, because the measurement was of a model that could not do the
task. Counts are necessary, not sufficient. The provider on the run is the other
half of the record.

---

## The sibling mistake: verifying a stale artifact

Already recorded in memory as `bootrun-stale-bundle`, repeated here because it
is the same shape of error. Restart `spectro-server` after `npm run build` or
the browser reads the previous bundle: `bootRun` serves
`build/resources/main/static`, while `npm run build` writes
`src/main/resources/static`.

The pattern behind all three mistakes in this document is one sentence: **the
thing under test was not the thing that ran.** A weak model instead of the
intended one, a stale bundle instead of the new one, a settings file instead of
the env var you set. Each is cheap to rule out and expensive to miss.

---

## Checklist

Before you write a verdict about a model-driven feature:

- [ ] `spectro doctor` (or `GET /api/settings`) confirms the provider and model
      you intended are the ones in effect, with no shadowed-env line about them.
- [ ] The model and provider are written into the verdict, not just the outcome.
- [ ] A direct probe against `localhost:11434/api/chat` shows this model can do
      the underlying task, on more than one run.
- [ ] The artifact under test is freshly built. Server restarted after
      `npm run build`.
- [ ] The run was repeated. More than one sample.
- [ ] Counts recorded per unit, not only in total: units in, units out,
      non-empty outputs, output size each.
- [ ] No component's own success signal is doing the work of the evidence.
- [ ] If the feature failed: the same request was sent to the provider's
      endpoint directly, and the two sets of numbers are in the verdict.

Before you report a defect in our code, the probe passed. Before you report a
model limitation, the layer comparison came back clean.
