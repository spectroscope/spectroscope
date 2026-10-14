# Agent Picker

Status: design, written 2026-10-13 for review. Card 593. Built on the integration branch after card 586 lands there; the branch `card-593` starts at c7c16528.

## Goal

Every view that shows one agent's data says which agent it shows and offers a picker over the agents of the session. 3 views need it: the context ring with its popover, the Plan panel and the System context panel. One choice drives all 3.

## Decisions

Taken by the owner on 2026-10-13 (`kanban/evidence/feedback-2026-10-13/owner-words-2026-10-13.md`, last two sections). They are not open.

| Question | Answer |
|---|---|
| One selection or one per view | One selection for all agent views; a change in one place changes all. The accepted mockup shows "Zeigt: explore-1" in the Plan panel and in the context popover of the ring |
| What a helper's context view shows | Its fill, its model and its parts with their sizes, without the texts. Helpers report part sizes each turn (a small core change) |
| Helper plans | None, as today. For a helper the Plan view says it keeps no plan |
| The empty Plan view | Seen "in a normal chat with helpers". Not reproduced in code |
| Release | With the release of 2026-10-13 |

## Facts

Measured on the integration branch at c7c16528 on 2026-10-13 (`kanban/evidence/593/survey-context.md`, `survey-plan.md`, `survey-agents.md`). Web paths are under `spectro-web/src/`, core paths under `spectro-core/src/main/java/dev/spectroscope/core/`.

- 33 web surfaces show agent data. 21 are agent-scoped, 18 of them keyed per agent. 3 show one agent without saying which: the ring (`components/ContextRing.tsx:59`, root only), the Plan panel (`components/PlanTab.tsx:17`, latest writer wins) and the System context panel (`components/SystemContextTab.tsx:111`, keyed through `RightPanel.selectedId`).
- The ring reads `UiState.context`, `lastInputTokens` and `announcedWindow`, written for the root agent only (`state/reducer.ts:1892-1895`, `:1998-2019`). A child's `context_info` is dropped at `reducer.ts:2004` (card 521).
- A child emits `usage`, `run_start`, `agent_spawn`, `agent_message` and `llm_exchange` with its own id. It emits no `context_info`: 0 of 1,025 lines in 76 session files. The one emission site is `Agent.java:854-856`, on when `options.introspection()` is true; only `SessionConnection.java:4395` and `SpectroCli.java:1023` set it, and the child builder `subagents/SubagentManager.java:1284-1343` never does.
- The reducer drops a child's `run_start` model and window (`reducer.ts:676-682`, `:1337-1339`). Only an import sets `AgentInfo.model` (`:2126`).
- A main `context_info` line averages 43,820 bytes; the 12 multi-agent files hold 65.0 % of their bytes in these lines. Part texts are capped at 16,384 characters (`Agent.java:1967`). `ContextPart(label, chars, estTokens, text)` carries `@JsonInclude(NON_NULL)` (`events/RunEvent.java:1208-1209`); the web types already mark `text` optional (`events.ts:215`, `reducer.ts:266`).
- A helper's window is derived per run from its own provider (`Agent.java:626-637`) and rides on its `run_start` since card 521 (`:731-734`, `withWindow` at `RunEvent.java:246-249`). A spawned child uses the chat's provider (`SubagentManager.java:1276`); only a playbook step child runs on another model.
- The plan has one slot. `update_plan` is registered for the main agent only (`spectro-server/.../SessionConnection.java:4238`, fence `:4283-4293`); the playbook runner writes the same slot as `playbook`. `case "plan"` has no agent guard (`reducer.ts:2048-2051`). 13 child frame kinds leave the root plan untouched by reference (survey-plan, repro S1); 0 child plan lines exist in 76 files.
- Selection today: `RightPanel.selectedId` (`components/RightPanel.tsx:215`), set by the Agents tab through `selectAgent` (`:239-242`), which also opens the context panel. It drives the System context panel only and is never reset; a missing id falls back to the root without a word (`:216`).
- The roster `UiState.agents` lists the root first and every helper in order of first appearance (`reducer.ts:674-733`). `rootAgentId` (`:435`) names the root; 4 readers still compare against the literal `main` (`Chat.tsx:1071`, `ToolCard.tsx:37`, `TextView.tsx:341`, `lab/labScene.ts:82`).
- The wire has no name field. A helper is its id, type plus counter (`SubagentManager.java:1051-1054`); `label` is the dev tool (`build_plan`, `playbook:<step>`) or null. The Agents tab, the chat badges and the trace chips print the raw id.
- No shared dropdown exists. 6 popovers repeat the outside-click and Escape handlers; shared are `nextMenuIndex` (`panels/headerPanelControls.tsx:79`), `dismissesMenu` and `MODAL_LAYER` (`components/menuDismiss.ts`).
- Card 586 gives `PlanTab` the props `runs`, `planAgent`, `live`, `wide`, `onToggleWide`, `onJump`, `onOpenPath`, adds `UiState.runs`, `RunPanel`, `revealRunPanel` and `chatFocus`, and keeps the `playbook` id out of every roster.

## Design

### 1. Selection

- A module store `state/shownAgent.ts`, keyed by the record in view: the live slot's key (`sessions.view().key`, `App.tsx:1791`) or `replay.id` for a stored session. API: `useShownAgent(viewKey): string | null` (null means the root), `setShownAgent(viewKey, id)`, `forgetShownAgent(viewKey)`, `__resetShownAgentForTests()`. App forgets a key when it closes the slot; a new chat is a new key; nothing is persisted, so a reload starts at the root.
- A pure resolver `shownAgentOf(state, choice): ShownAgent` with `{ id, isRoot, row: AgentInfo | null, missing: string | null }`. The root is `rootAgentId`, else the first roster row without a parent, else `main`. A choice outside the roster resolves to the root with `missing` set, and the label then says so instead of falling back without a word.
- App resolves the selection once per render and hands the same `ShownAgent` and one `onPickAgent` to `Chat` (through `composerMeta`) and to `RightPanel`. `RightPanel.selectedId` goes; `selectAgent` sets the store and opens the context panel as today, so `dockOpeners.drift.test.ts` keeps its one site.

Departure from the draft: the draft put the selection into the session's state. `UiState` is folded from wire events only (`reduce(state, event)`), the stored view is `replay.state` outside the `SessionSet` (`App.tsx:2179`), and the only non-wire patch today is `outboxAttachments` (`state/sessionSet.ts:501`). A keyed store serves both views with one mechanism and still resets on a session switch, because the key changes.

### 2. Picker

- One component `components/AgentPicker.tsx` with props `agents`, `shown: ShownAgent`, `onPick(id: string | null)`, used by the popover, the Plan panel and the System context panel.
- The label reads `pick.showing` with the name: `pick.main` for the root, the raw id for a helper. The id is what the accepted mockup shows and what every other surface prints; the Lab's handle plus name stays the Lab's.
- The list: the root first, then every roster row with a parent, in roster order (that is spawn order). A row shows a dot for `submitted` and `working`, the id in mono, the dev-tool label when present, the task clipped to 40 characters, and `pick.ended` for `completed` and `failed`. Rows without a parent that are not the root (`session-title`, if it ever lands) are left out; `playbook` never reaches the roster.
- Markup: a button with `aria-haspopup="listbox"` and `aria-expanded`, a `role="listbox"` with `role="option"` rows and `aria-selected`. ArrowUp, ArrowDown, Home and End move through `nextMenuIndex`; Enter picks; Escape closes the list and stops its propagation, so the popover's document listener (`ContextRing.tsx:109-113`) does not close the popover on the same key; an outside press closes through `dismissesMenu`.
- With one agent the label still shows and the chevron is disabled (`aria-disabled`). With `missing` set the label names the root and a second line `pick.missing` names the id that is gone.

### 3. Context

- `ContextRing` takes `shown` and the figures of the shown agent: `lastInputTokens`, `context`, `announcedWindow`. `Chat` picks them by `shown.id`: `state` for the root, `state.helpers[id]` for a helper, at both call sites (`Chat.tsx:1850-1858`, `:1936-1943`).
- The ring is drawn when the root has a fill, as today (`ComposerMeta.tsx:256`). For a helper it shows the helper's fill, 0 % until its first `usage`. The percentage text gets the helper id in front, coloured by `agentAccent(id)` (`format.ts:111`). The aria label becomes `ring.aria` ("Context of {name}, {pct} percent full"); today's literal carries a dash and goes.
- The math is unchanged: `ringFrame(context, announcedWindow)` and `contextGauge` (`components/contextRingMath.ts:171-237`) are fed the helper's own snapshot and announcement. A helper's window comes from its own sizes-only `context_info` (threshold, source and window ride on every frame, `Agent.java:1910-1916`) and, before its first snapshot, from its `run_start`. A helper with no window shows tokens, `ctx.window.unknown` and no percentage line in the popover; the ring then divides by the fallback as it does for a root without a window (`contextRingMath.ts:47-58`).
- The fill of a helper is its last `usage`: input plus cache read plus cache creation, the root's formula (`reducer.ts:1892-1895`, `Agent.java:2032-2034`).
- Popover for the root: as today, with the picker under the eyebrow, the writable session window row included.
- Popover for a helper: the picker, the headline (tokens of window, or tokens alone), the compaction line, `ctx.helperModel` from `AgentInfo.model`, the parts table with chars and tokens from the helper's snapshot, the messages and turn line, and one note `ctx.helperNoParts`. Without a snapshot (an old session, or a helper before its first turn) the table is replaced by `ctx.helperNoSnapshot`. The session window row and the credits line are left out: the window belongs to the session (`RunEvent.java:1180-1181`) and the credits are counted for the whole session.

Departure from the draft: the draft let a spawned child "share the chat's window". The chat and a spawned child derive the same window because they use one provider; the web applies no such rule and never copies the chat's window onto a helper. A step child on another model would get a wrong number that way, and the helper's own frame carries the right one each turn.

### 4. Core

- `AgentOptions` gets the component `Boolean introspectionTexts`: null or true keeps the texts, false sends sizes only. It is appended with the compatibility constructor pattern the record already uses (`AgentOptions.java:205`); builder `introspectionTexts(boolean)`.
- `Agent.contextInfo` (`Agent.java:1877-1917`) keeps the full char counts and passes `null` as text when texts are off; `renderConversation` and the schema text are not built then.
- The child builder (`SubagentManager.java:1284-1343`) sets `.introspection(true).introspectionTexts(false)`. The main agent (`SessionConnection.java:4395`) and the CLI (`SpectroCli.java:1023`) are unchanged: texts ride.
- Wire: a null `text` leaves the key off, by the existing `@JsonInclude(NON_NULL)` on `ContextPart`. `RunEventJsonTest.java:44` already round-trips a null-text part but asserts no JSON shape; a new test pins that the serialized sizes-only line has no `"text"` key, reads back equal, and that a texts line keeps `"text"`. The frame stays additive; the web type needs no change.
- Size: one sizes-only line with three parts is 363 bytes (counted 2026-10-13 with Python `json.dumps` on a sample line in the record's field order, six-digit counts). The 451 child turns of the survey sample add 164 kB, against 19.8 MB with texts; one line is 0.83 % of the mean main line.
- Readers: `spectro-cli/.../EventRenderer.java:435` and `session/SessionStore.java:1183` read only the agent id of a `context_info`; neither changes. Web readers that walk part texts already guard the absence (`state/textFeed.ts:200`) or read sizes only (`components/eventDetail.ts:393-412`, the popover, `lab/flowmap/sceneToFlow.ts:743-744` for the root). Comments and test names that say children emit no `context_info` change their words: `subagents/SubagentConfig.java:43-49`, `SubagentThresholdInheritanceTest.java:37`, `SubagentSessionWindowTest.java:34`, `lab/contextPeakMath.ts:15-22`, `lab/flowmap/ctxTotalsSource.test.ts:4-5`, `reducer.ts:2001-2003` and the `UiState.context` doc (`:414-415`).

### 5. Web state

- `UiState.helpers: Record<string, HelperFigures>` with `{ lastInputTokens: number; context: ContextSnapshot | null; announcedWindow: WindowAnnouncement | null }`, keyed by agent id; the root never lands in it. Written by `usage` (the fill), `context_info` (the snapshot, announcement cleared) and a `run_start` with `parentId` (the announcement from `contextWindow` and `windowSource`). The root's three fields stay where the ring math and the card 521 tests read them; the guard at `reducer.ts:2004` turns from "drop" into "write the helper slot".
- `AgentInfo.model` is set from a child's `run_start` model (`reducer.ts:676-682` today sets none). The field's doc changes, and the Agents tab shows the model chip for live helpers as a consequence (`AgentsTab.tsx:68`). The root's model stays in `runModel`.
- `UiState.plans: Record<string, PlanStep[]>`, keyed by the writer's agent id (`main` or `playbook`). `plan` and `planAgent` stay as the latest frame for the footer (`planVerdict.ts:54`) and the HTML export (`export/html.ts:703`).
- `context_cleared` and `window_override` keep rewriting the root's fields only. A helper on the chat model reports the new window on its next `context_info`.
- `initialState` adds `helpers: {}` and `plans: {}`. The archive fixture (`testkit/archiveEvents.ts`) gets one child `context_info` without texts per cycle, so `archiveFold` covers the helper slot.

### 6. Views

- Plan: the picker heads the model's plan. With runs, card 586 draws `RunPanel` first and the model's plan under "Plan of the model"; the picker sits in that section, because the run panel belongs to a run and the picker to an agent. For the root the list is `plans[root]`; empty shows `plan.empty` as today. For a helper the panel shows one line `plan.helperNone` and no list. 586's condition `planAgent !== "playbook"` becomes "`plans[root]` is present". A session with no runs and no root plan but a playbook plan keeps showing the playbook rows, as today.
- System context: `selected` is the shown row; the picker heads the tab; the lead sentence stays; the model line reads `AgentInfo.model` for a helper when set, else the session's model as today.
- Agents tab: `selectedId` is the shown id, so the root row is marked by default; a click sets the selection and opens the context panel as today.
- Not wired, with the reason: the composer strip (goal, loop and `runTurn` belong to the session and the root run); Lab, Spectrum, Trace and Work (keyed per agent with their own filters, `traceAgent` and `workHighlight`); the model chip, the thinking chip, the gear and the session settings (they belong to the session).

### 7. Translation

| Key | en | de |
|---|---|---|
| `pick.showing` | `Showing: {name}` | `Zeigt: {name}` |
| `pick.main` | `Main agent` | `Hauptagent` |
| `pick.aria` | `Choose the agent to show` | `Agenten zum Anzeigen wählen` |
| `pick.ended` | `ended` | `beendet` |
| `pick.missing` | `{id} is not in this session. Showing the main agent.` | `{id} ist nicht in dieser Session. Gezeigt wird der Hauptagent.` |
| `plan.helperNone` | `{id} keeps no plan. Helpers work from their task; the main agent keeps the plan.` | `{id} führt keinen Plan. Helfer arbeiten nach ihrem Auftrag; den Plan führt der Hauptagent.` |
| `ctx.helperModel` | `model {model}` | `Modell {model}` |
| `ctx.helperNoParts` | `Helpers record the sizes of their parts, not the texts.` | `Helfer zeichnen die Größen ihrer Teile auf, nicht die Texte.` |
| `ctx.helperNoSnapshot` | `No parts were recorded for {id} in this session.` | `Für {id} wurden in dieser Session keine Teile aufgezeichnet.` |
| `ring.aria` | `Context of {name}, {pct} percent full` | `Kontext von {name}, {pct} Prozent voll` |

### 8. Empty plan view

The case is not reproduced. The exhaustive grep over the writers of `plan` and `planAgent` and the 13-frame repro (survey-plan) show no child frame that empties the slot. Three candidates remain, none of them measured:

1. The record in view is not the one holding the plan: `newChat`, `select` and `close` change it (`state/sessionSet.ts:306`, `:404`, `:411`), and a stored session swaps in `replay.state` (`App.tsx:2179`).
2. No `plan` frame reached the record: `update_plan` answers ERROR without an event on a bad step (`tools/UpdatePlanTool.java:97-113`), or the full view came from the playbook's rows and the model never called `update_plan` afterwards.
3. A `plan` frame with `steps: []`, which only the playbook runner can send, when the forward path is empty (`playbook/run/PlaybookWalk.java:38-56`).

This card adds the per-writer slots of section 5 and two tests: the root plan survives the 13 child frame kinds plus a child `plan` frame with empty steps, by reference; and a session switch round trip through `SessionSet` (select another record, select back) still renders the plan. Next time the owner can note the session (the folder chip copies its path), the clock time, whether a playbook run was on and which agent the Agents tab had selected. With that, the session file's last `plan` frame (its `agentId` and steps length) is read in a test through `foldArchive` (`state/archiveFold.ts:37`) or in the Trace tab.

## Error handling

- Roster empty, before the first `run_start`: the root is unknown; the label reads `pick.main`, the chevron is disabled.
- Choice outside the roster: the views show the root and the label says `pick.missing`. Today `agents.find(...) ?? null` falls back without a word.
- A helper without `usage`: 0 tokens, ring at 0 %. Without a window: tokens and `ctx.window.unknown`, no percentage line. Without a snapshot: `ctx.helperNoSnapshot`.
- An ended helper stays in the list with `pick.ended`; its figures stay, because the roster is never cleared (`reducer.ts:281-286`).
- A resumed session may reuse `explore-1` (the counter lives per connection, `SubagentManager.java:131`, unverified): the newer run's figures replace the older under the same id, as the roster does today.
- A child's `context_info` cannot precede its `run_start`; the fold still creates the helper slot on first sight.
- Escape with the list open closes the list only; the next Escape closes the popover.

## Testing

- Reducer: helper figures from `usage`, `context_info` and `run_start`; the root's fields untouched by every child frame (`state/storedSessionWindow.test.tsx:90-104` stays green and gets an assertion on `helpers.worker`); `plans` per writer with `plan` and `planAgent` unchanged (`state/reducer.test.ts:1355-1380` stays); the root plan survives the 13 child frames and an empty child plan by reference; the legacy playbook fallback.
- Store and resolver: keyed by view key, forgotten on close, a missing id resolves to the root with `missing` set, the root from `rootAgentId` on a standalone subagent transcript.
- Components: `AgentPicker` click, ArrowDown plus Enter, Escape closes the list and not the popover, one agent disables the chevron, EN and DE labels; `ContextRing` with a helper shows the prefix, the aria label, the model line, the parts table, no session window row and no credits line; `PlanTab` for a helper shows `plan.helperNone`; `RightPanel` without `selectedId`; one test sets the store and asserts that the popover, the Plan panel and the System context panel name the same agent.
- Core: a child built by `SubagentManager` with a fake provider emits `context_info` whose parts have full char counts and no text; an agent built with texts keeps them; the new `AgentOptions` component and its compatibility constructor.
- Wire: the JSON test of section 4.
- Drift: i18n (both languages, each placeholder once, no card numbers, slot fills); `archiveFold.test.ts` keeps its slice budget with the new fixture frame; `dockOpeners.drift.test.ts` is untouched unless the build adds an opener; `styles/composerPopoverSides.drift.test.ts` if the popover's classes change.
- Every new test red first; a bite per guard: the moved agent guard, the identity of the root plan, the missing-id label, the null text, the Escape propagation.
- Browser: Playwright against the installed Chrome channel, both themes, at 800 px and 1280 px, on a replayed session with two helpers: a pick in the popover, and the Plan panel and the System context panel follow.
- Live: the test app, one chat on the house backend (Ollama `minimax-m3:cloud`, the 0.15.x exception), a prompt that spawns an explore child; pick the child in the ring; the popover shows its fill, its model and three parts with sizes; the Plan panel says it keeps no plan; `grep -c '"context_info"' <session>.jsonl` counts the child's lines, none of them with `"text"`.

## Non-goals

- Helper plans; the belt fence stays (`SessionConnection.java:4283-4293`).
- Helper part texts; the llm-wire sidecar holds each helper's verbatim request.
- Persisting the selection across a reload or into `layout.ts`.
- The composer strip, Lab, Spectrum, Trace and Work.
- A percentage for a helper in the Lab's context peak; `lab/contextPeakMath.ts` could now read the helper's window, a card of its own.
- The 4 `main` literals named under Facts.

## After 586

- Base: the integration branch after the 586 merge; rebase `card-593` onto it first.
- Names from 586 in use here: `UiState.runs`, `RunPanel`, `revealRunPanel`, the `PlanTab` props `runs`, `planAgent`, `live`, `wide`, `onToggleWide`, `onJump`, `onOpenPath`. `chatFocus` has an `agent` target; the picker does not use it.
- Files both cards touch: `state/reducer.ts` (the `UiState` hunk next to `plan` and `planAgent` at `:459-464`, `initialState` at `:553-554`, the switch around `case "plan"` at `:2048` and 586's `case "run_step"`), `components/PlanTab.tsx`, `components/RightPanel.tsx` (`:136`, `:163`, `:215`, `:370`), `App.tsx` (`:3268-3279`), `i18n/i18n.ts`, `state/reducer.test.ts`, `components/PlanTab.test.ts`, `testkit/archiveEvents.ts`, `docs/guide-assets/parts/05-web-tabs.html` (the Plan panel paragraph; 593 adds one sentence each for the picker and the popover). 586 adds sites to `dockOpeners.drift.test.ts`; 593 adds none.
- Order inside 593: core and wire first (independent of 586), then the reducer, then the picker, then the three views.
