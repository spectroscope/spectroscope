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
only `.jsonl` files are read as sessions and this README is passed over. Then
the run replays on every face: chat, spectrum, trace, and the lab with its
workflow box.

**English only, on purpose.** `compile()` takes a language and bakes it into
the events, so every thought, message and status line in the file is prose in
one language. This repo's docs and code are English, and a reader who opens
the file to see the shape of the wire should not have to read German to do it.
A German twin would be a second file with a second pin behind it; ask for it
if you want it.
