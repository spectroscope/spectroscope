# The render engine (card 42)

One render world under three surfaces: the **Lab** and the **fleet machine
room** here in spectro-web, and the **simulator + edu lessons** in the
(private) spectroscope-edu app. A feature built against this engine shows up
on all of them; a feature built past it is a fork waiting to drift.

## Canonical source

THIS directory is canonical. The edu app consumes the engine as a vendored,
byte-derived copy — `spectroscope-edu-suite/tools/sync_engine.py` copies the
manifest below into the app (re-formatted with the app's prettier config) and
its `--check` mode fails on drift. True single-source packaging (one published
module) is deliberately NOT this card: it depends on the platform/repo split
(card 68). Until then: canonical here, mechanically synced there, drift gated.

## Manifest (what the engine IS)

| file                                          | role                                                              |
| --------------------------------------------- | ----------------------------------------------------------------- |
| `labScene.ts`                                 | the per-agent scene fold (`advanceLoop` is the shared transition) |
| `sceneNow.ts`                                 | names the current station (the "now" bands)                       |
| `petriModel.ts`                               | the stepper's formal marking invariant                            |
| `flowmap/sceneToFlow.ts`                      | scene + detail → React Flow nodes/edges (single-run layout)       |
| `flowmap/nodes.tsx`                           | the node cards (user/agent/os/llm/ext/subagent/zone)              |
| `flowmap/PacketEdge.tsx`                      | the rails + riding packets                                        |
| `flowmap/NeuralNet.tsx`, `flowmap/glyphs.tsx` | the LLM/station visuals                                           |
| `flowmap/positions.ts`                        | drag-pinning + position merge across re-folds                     |
| `flowmap/expandContext.ts`                    | `ExpandAllContext` (default false)                                |
| `flowmap/imageUrl.ts`                         | blobPath → browser URL (store blob vs bundled /demo asset)        |
| `flowmap/flowmap.css`                         | the engine's whole look (tokens only)                             |
| `FlowMap.tsx`                                 | the single-run canvas shell around all of the above               |
| + the `.test.ts` siblings                     | the engine's behavior pins travel with it                         |

NOT engine: `FleetLab.tsx` / `fleetLabScene.ts` / `flowmap/fleetToFlow.ts`
(they import the fleet model from `../spectrum` and stay harness-side until
the edu app grows a fleet story), the stepper store, and every shell.

## The flags (how surfaces differ without forking)

- **`ExpandAllContext`** — a shell that provides `true` renders every card
  with its disclosures open (edu lessons: the full instrument at a glance).
  The wide-user/expanded styles are SHELL css by design (see edu's
  `styles/edu.css`); default `false` renders exactly the compact Lab look.
- **`sceneToFlow(..., { declutter })`** — drops the mac/outside frames, the
  boundary and the external services; only the OS band frame stays. For
  lesson cameras; never the default.
- **`sceneToFlow(..., { subSlots })`** — reserves N worker slots so a card
  never slides when a sibling spawns. Defaults to the live count.

All three default OFF, and `sceneToFlow.test.ts` pins both the default and
the flagged shapes.

## The drive contract

The engine renders a FOLD, it never owns time: `events[0..n] → fold → flow`,
deterministic for every prefix. Anything that can produce an events prefix is
a valid drive — the Lab's stepper store, the machine room's cursor transport,
the edu app's compile→loadReplay drive, a live socket. Unifying the drives
themselves is card 68 territory; the contract they all already satisfy is
this line.
