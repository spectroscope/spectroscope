# Structured tool views for every tool — design

**Date:** 2026-07-27 · **Owner ask:** "diese skills structured output sehen nicht
so structured aus … markdown parsing und syntax und code highlighting, Pflicht
und Kür" · **Scope approved:** Pflicht + Kür in full.

## The problem, measured

The `structured` face is not a JSON pretty-printer. It has eight real shapes
and renders them from typed fields. It just does not know most tool names.

`describeTool()` (`src/components/toolViews.ts:50-126`) switches on ten
snake_case names. Everything else returns `generic`, which renders
`prettyJson(input)` into a `<pre>` — the wall of JSON in the owner's
screenshots.

Two populations fall through:

**Imported Claude Code transcripts.** The importer passes the provider's tool
name through verbatim (`src/import/claudeCode.ts:110`), which is correct: the
JSONL must say what the provider said. But Claude Code names are PascalCase
(`Read`, `Bash`, `Skill`, `Edit`), so *every* card from an imported transcript
renders as raw JSON.

**Native tools with no shape.** Counted in a real store
(`~/.spectro/sessions`): `report_status` ×7, `generate_image` ×6,
`update_plan` ×4, `spawn_agents` ×4, `mcp__notes__search_notes`,
`web_search`, `web_fetch`, `build_plan`.

A third defect surfaced while mapping this: **the copy button is invisible.**
`.copy` is `position: absolute; opacity: 0` and is only raised by
`.output-wrap:hover` (`src/styles/toolcard.css:177-193`). `.output-wrap` exists
in no TSX any more. `.tv-copy` (`:227`) overrides neither property. The same
root cause hits `CopyButton` inside `Markdown.tsx:74`, so the copy button on
every fenced code block in every assistant answer is invisible too. Both are
reachable by keyboard focus only.

## What already exists (this is wiring, not new machinery)

- `src/markdown/parse.ts` + `src/components/Markdown.tsx` — a tested markdown
  parser and React renderer: headings, paragraphs, fenced code with a language
  chip, lists, quotes, tables with alignment, protocol-allow-listed links,
  never raw HTML. Used in Chat, SystemContext and Workspace. Not in the tool
  card.
- `src/workspace/highlight.ts` — a CSP-safe, dependency-free tokenizer for
  java, python, shell and json, lossless by a property-tested invariant. Used
  only in the workspace file preview. Its token colours live in
  `src/styles/panels.css:148-152`, scoped to `.ws-code`.

No new dependency is needed, and none will be added.

## Non-goals

- **No wire change.** `events.ts` is the frozen contract shared with the JSONL
  on disk. Tool names are not rewritten at import. The translation lives in the
  view, so a session keeps saying what the provider said.
- No change to the three-face model (structured / json / raw) or to the global
  face preference.
- No refactor of the reducer, the card shell, or the permission chip.

## Architecture

Three layers, matching what is there.

**1. `src/components/toolVocabulary.ts` (new, pure).** One table mapping a wire
name to a canonical kind plus a display label. It is the single vocabulary for
the whole app.

Today two independent name switches exist and disagree: `describeTool()`
(`toolViews.ts`) and `toolLabel()` (`src/graph/overviewModel.ts:83-99`). The
graph knows `web_fetch`, `web_search`, `browse_page` and `mcp__*`; the card
does not. Both will consume this table, so the divergence cannot return.

Matching is exact on the name, plus one prefix rule for `mcp__`. No fuzzy
matching: an unknown tool must land in `generic` rather than be guessed into
the wrong shape.

**2. `toolViews.ts` (extended).** `describeTool()` resolves the kind through
the vocabulary, then reads the typed fields for that kind. Field names differ
per vocabulary (Claude Code says `file_path`, spectroscope says `path`), so
each kind accepts its known aliases.

**The honesty rule stays load-bearing** (documented at `toolViews.ts:6-8`): if a
required field is absent or the wrong type, the branch returns `generic`. A
pretty but empty card is worse than honest JSON.

**3. `ToolViewBody.tsx` (extended).** One renderer per new kind, plus markdown
and highlighting wired into the existing ones.

## The vocabulary

| Claude Code | native | kind |
|---|---|---|
| `Read` | `read_file`, `view_file` | `file` |
| `Write` | `write_file` | `write` |
| `Edit` | `edit_file` | `edit` |
| `Bash` | `run_command` | `command` |
| `Glob`, `Grep` | `glob`, `grep` | `matches` |
| `LS` | `list_dir` | `listing` |
| `Skill` | `use_skill` | `skill` |
| `TodoWrite` | `update_plan` | `plan` (new) |
| `Task` | `spawn_agent`, `spawn_agents`, `build_plan`, `write_spec`, `develop`, `test` | `agents` (new) |
| `WebFetch`, `WebSearch` | `web_fetch`, `web_search`, `browse_page` | `web` (new) |
| — | `mcp__<server>__<tool>` | `mcp` (new) |
| — | `generate_image`, `view_image` | `image` (rebuilt) |
| — | `report_status` | `note` (new) |

Field aliases per kind: `path` | `file_path`, `content`, `old_string` |
`oldString`, `new_string` | `newString`, `command`, `pattern`, `name` | `skill`,
`url`, `query`, `prompt`, `steps` | `todos`, `message`.

## The shapes

**Already good, small polish only.** `file`, `write`, `edit`, `listing`,
`matches`, `command`, `skill` render from typed fields today. The listing
already marks directories; the command already has a `$` prompt and a failure
tint. They gain highlighting and (where the content is markdown) markdown.

**Rebuilt:** `image` currently renders the path and nothing else
(`ToolViewBody.tsx:144-149`). It will render the actual image via
`/api/images/<file>`, with the existing `onError` → placeholder pattern so a
backend-free build stays clean.

**New:**

- `plan` — a real checklist. One row per step with a status chip (pending,
  in progress, completed). Falls back to `generic` if `steps` is not an array
  of objects carrying `text`.
- `agents` — one row per spawned agent: type and task. `spawn_agent` is the
  one-agent case of the same shape.
- `web` — the URL or query as the subject line, the result body below;
  markdown when the tool returned markdown (`browse_page` does).
- `mcp` — the composed name split into server and tool, so
  `mcp__notes__search_notes` reads as `notes · search_notes` rather than as one
  unbroken token, with the argument object below.
- `note` — `report_status` is a single message. One line, no well.

**`edit` gets the real diff.** The before/after tints already exist unused at
`src/styles/toolcard.css:304-305`.

## Markdown policy

Markdown is applied only where the payload **is** markdown. Running a shell
transcript through a markdown parser mangles it, so the choice is by evidence,
not by default:

- `skill` output — always. Skill bodies are markdown by construction.
- `file` output — when the path ends in `.md`, `.markdown` or `.mdx`.
- `web` output — when the tool is `browse_page` or `WebFetch`, which return
  markdown by contract.

Everywhere else the well stays verbatim.

## Highlighting policy

`highlight.ts` picks a language from the file extension for `file`, `write` and
`edit`; `shell` for `command`; `json` when a body parses as JSON. For a
language the tokenizer does not know (TypeScript, for one) the body renders
**plain rather than mis-tokenized** — the same honesty rule as the shapes.

The `.hl-*` colours move out of the `.ws-code` scope into a shared class
consumed by both the workspace preview and the tool well. They already carry
their light-design values, so both themes are covered.

## The copy button

`.tv-copy` and `.md-pre-head .copy` get `position: static; opacity: 1`, the fix
the two other call sites already apply (`panels.css:546-547`, `graph.css:89`).
The dead `.output-wrap:hover` rule goes.

## Testing

`src/components/toolViews.test.ts` has 16 cases across every branch including
the fallbacks. It grows:

- one case per new kind (`plan`, `agents`, `web`, `mcp`, `note`)
- one case per vocabulary pair, proving `Read` and `read_file` produce the same
  shape from their own field names
- honesty fallbacks per new kind: required field missing or wrong type →
  `generic`
- the `mcp__` prefix rule, including a name with underscores in the tool part
- the markdown decision: `.md` path renders markdown, `.sh` path does not
- the highlight decision: an unknown language returns plain tokens

Renderer behaviour that the pure tests cannot reach (the image `onError`
fallback, the copy button being visible) is verified live in the browser, in
both themes, per the house rule.

## Risks

- **Wrong shape on a name collision.** Mitigated by exact matching and the
  honesty fallback: a mis-mapped name still cannot render fields it does not
  have.
- **Markdown eating content.** Mitigated by the evidence rule above and by the
  raw face, which always shows the untouched string.
- **Scope creep into the card shell.** The card shell, the face switcher and
  the reducer are out of scope.
