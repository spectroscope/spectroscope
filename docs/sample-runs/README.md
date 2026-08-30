# sample runs

One recorded run, as the app's own JSONL, so you can open a real multi-agent
stream without a key, a server or a model.

## workflow-phases.en.jsonl

The built-in `workflow-phases` scenario: a declared workflow of five phases —
scope, probe, merge, draft, audit — run by 13 agents, with two fan-outs of
five. 196 events on 196 lines, 25,782 bytes.

**It is generated, not captured.** The source is the scenario in
`spectro-web/src/scenario/registry.ts`; `compile()` turns it into events
against a fixed base timestamp, so the same source always produces the same
bytes. To rewrite the file:

```
cd spectro-web && npm run generate:sample-run
```

`sampleRecording.test.ts` compares the committed file against that same call
on every test run, so it cannot drift away from the scenario in silence.

**How to open it.** In the app: the import dialog takes a single file, or a
whole folder — pointing the folder picker at this directory works too, because
only `.jsonl` files are read as sessions and this README is passed over. It
then behaves like any other imported session: the chat, the trace and the rest
of the tabs replay it, and scrubbing into the run puts the agents on the lab's
map.

**The workflow box is not in this file, and cannot be.** The five columns are
*declared* — they live in the scenario, and `compile()` does not write them to
the wire, so no `.jsonl` carries them. Measured through the app's own chain,
an import of these bytes draws zero workflow boxes and the agents stand loose;
the same bytes draw one box the moment a declaration is handed in. To see the
box, load **Declared workflow · 5 phases, 13 agents** from the scenario picker
— it compiles this very run and passes the phases alongside it. Both halves of
that sentence are pinned in `sampleRecording.test.ts`, so this paragraph goes
red rather than stale if the wire ever learns to carry a declaration.

**English only, on purpose.** `compile()` takes a language and bakes it into
the events, so every thought, message and status line in the file is prose in
one language. This repo's docs and code are English, and a reader who opens
the file to see the shape of the wire should not have to read German to do it.
A German twin would be a second file with a second pin behind it; ask for it
if you want it.
