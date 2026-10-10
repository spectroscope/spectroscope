# Provenance

spectropowers is a copy of the superpowers skills by Jesse Vincent, renamed as a pack and edited to the spectroscope house rules. The MIT licence of the source is in `LICENSE` beside this file and travels with every copy.

| Field | Value |
|---|---|
| Source | https://github.com/obra/superpowers |
| Version | 6.3.0 (tag v6.3.0) |
| Commit | b36e0829c6d0140e93cfef2ca599b1b07d4a7797 |
| Licence | MIT, Copyright (c) 2025 Jesse Vincent |
| Vendored into spectroscope | 2026-10-09, `.spectro/skills-catalogue/superpowers` |
| Copied into this playbook | 2026-10-09, by `scripts/copy_spectropowers.py` |

## Skills

Every skill keeps its folder name and structure. One line per skill, source first.

- `superpowers:brainstorming` is `spectropowers:brainstorming`
- `superpowers:dispatching-parallel-agents` is `spectropowers:dispatching-parallel-agents`
- `superpowers:executing-plans` is `spectropowers:executing-plans`
- `superpowers:finishing-a-development-branch` is `spectropowers:finishing-a-development-branch`
- `superpowers:receiving-code-review` is `spectropowers:receiving-code-review`
- `superpowers:requesting-code-review` is `spectropowers:requesting-code-review`
- `superpowers:subagent-driven-development` is `spectropowers:subagent-driven-development`
- `superpowers:systematic-debugging` is `spectropowers:systematic-debugging`
- `superpowers:test-driven-development` is `spectropowers:test-driven-development`
- `superpowers:using-git-worktrees` is `spectropowers:using-git-worktrees`
- `superpowers:using-superpowers` is `spectropowers:using-spectropowers`
- `superpowers:verification-before-completion` is `spectropowers:verification-before-completion`
- `superpowers:writing-plans` is `spectropowers:writing-plans`
- `superpowers:writing-skills` is `spectropowers:writing-skills`

## Changed Files

Each file that differs from its source, with what changed. The list is computed from the two texts by the copy script.

| File | Change |
|---|---|
| `brainstorming/SKILL.md` | a ticket is the input of every path; the bounded path writes a short numbered plan into the ticket; chris-criticism runs on the spec before the user review gate; dashes used as punctuation replaced by commas, colons, semicolons or parentheses |
| `brainstorming/scripts/helper.js` | dashes used as punctuation replaced by commas, colons, semicolons or parentheses |
| `brainstorming/scripts/server.cjs` | dashes used as punctuation replaced by commas, colons, semicolons or parentheses |
| `brainstorming/scripts/start-server.sh` | dashes used as punctuation replaced by commas, colons, semicolons or parentheses |
| `brainstorming/spec-document-reviewer-prompt.md` | dashes used as punctuation replaced by commas, colons, semicolons or parentheses |
| `brainstorming/visual-companion.md` | dashes used as punctuation replaced by commas, colons, semicolons or parentheses |
| `dispatching-parallel-agents/SKILL.md` | dashes used as punctuation replaced by commas, colons, semicolons or parentheses |
| `executing-plans/SKILL.md` | the same stop rule for conflicts; progress goes into TASKS.md after every task; skill references renamed to spectropowers; dashes used as punctuation replaced by commas, colons, semicolons or parentheses; the pack is named spectropowers in prose |
| `finishing-a-development-branch/SKILL.md` | the merge uses --no-ff; the rulings list goes into TASKS.md before cleanup; chris-criticism runs once on the branch summary; dashes used as punctuation replaced by commas, colons, semicolons or parentheses; the pack is named spectropowers in prose |
| `receiving-code-review/SKILL.md` | dashes used as punctuation replaced by commas, colons, semicolons or parentheses |
| `requesting-code-review/SKILL.md` | the review base is the merge base of the branch, never HEAD~1; dashes used as punctuation replaced by commas, colons, semicolons or parentheses |
| `requesting-code-review/code-reviewer.md` | dashes used as punctuation replaced by commas, colons, semicolons or parentheses |
| `subagent-driven-development/SKILL.md` | architecture, language, repository and scope conflicts stop and go to the owner; the ledger is kept and its rulings go into TASKS.md and CLAUDE.md; the failing test comes first in every task; models follow the role rule; reviews may run in the background; skill references renamed to spectropowers; dashes used as punctuation replaced by commas, colons, semicolons or parentheses |
| `subagent-driven-development/implementer-prompt.md` | dashes used as punctuation replaced by commas, colons, semicolons or parentheses |
| `subagent-driven-development/re-review-prompt.md` | dashes used as punctuation replaced by commas, colons, semicolons or parentheses |
| `subagent-driven-development/scripts/sdd-workspace` | dashes used as punctuation replaced by commas, colons, semicolons or parentheses |
| `subagent-driven-development/task-reviewer-prompt.md` | dashes used as punctuation replaced by commas, colons, semicolons or parentheses |
| `systematic-debugging/CREATION-LOG.md` | dashes used as punctuation replaced by commas, colons, semicolons or parentheses |
| `systematic-debugging/SKILL.md` | skill references renamed to spectropowers; dashes used as punctuation replaced by commas, colons, semicolons or parentheses |
| `systematic-debugging/condition-based-waiting.md` | dashes used as punctuation replaced by commas, colons, semicolons or parentheses |
| `systematic-debugging/defense-in-depth.md` | dashes used as punctuation replaced by commas, colons, semicolons or parentheses |
| `systematic-debugging/root-cause-tracing.md` | dashes used as punctuation replaced by commas, colons, semicolons or parentheses |
| `systematic-debugging/test-pressure-1.md` | dashes used as punctuation replaced by commas, colons, semicolons or parentheses |
| `systematic-debugging/test-pressure-2.md` | dashes used as punctuation replaced by commas, colons, semicolons or parentheses |
| `systematic-debugging/test-pressure-3.md` | dashes used as punctuation replaced by commas, colons, semicolons or parentheses |
| `test-driven-development/SKILL.md` | the mutation probe is real: commit first, break the implementation, see red, restore; dashes used as punctuation replaced by commas, colons, semicolons or parentheses |
| `test-driven-development/writing-good-tests.md` | the mental mutation is replaced by the real mutation probe; skill references renamed to spectropowers; dashes used as punctuation replaced by commas, colons, semicolons or parentheses |
| `using-git-worktrees/SKILL.md` | dashes used as punctuation replaced by commas, colons, semicolons or parentheses |
| `using-spectropowers/SKILL.md` | the rule that user instructions take precedence over every skill is stated first; skill references renamed to spectropowers; dashes used as punctuation replaced by commas, colons, semicolons or parentheses; the pack is named spectropowers in prose |
| `using-spectropowers/references/antigravity-tools.md` | dashes used as punctuation replaced by commas, colons, semicolons or parentheses |
| `using-spectropowers/references/codex-tools.md` | dashes used as punctuation replaced by commas, colons, semicolons or parentheses |
| `using-spectropowers/references/gemini-tools.md` | skill references renamed to spectropowers; dashes used as punctuation replaced by commas, colons, semicolons or parentheses |
| `verification-before-completion/SKILL.md` | gates run with a forced rerun and never through a pipe; UI work is verified in a browser in both themes at two widths; dashes used as punctuation replaced by commas, colons, semicolons or parentheses |
| `writing-plans/SKILL.md` | the plan header names the ticket; commit steps stage explicit paths; skill references renamed to spectropowers; dashes used as punctuation replaced by commas, colons, semicolons or parentheses |
| `writing-plans/plan-document-reviewer-prompt.md` | dashes used as punctuation replaced by commas, colons, semicolons or parentheses |
| `writing-skills/SKILL.md` | skill references renamed to spectropowers; dashes used as punctuation replaced by commas, colons, semicolons or parentheses |
| `writing-skills/anthropic-best-practices.md` | dashes used as punctuation replaced by commas, colons, semicolons or parentheses |
| `writing-skills/examples/CLAUDE_MD_TESTING.md` | dashes used as punctuation replaced by commas, colons, semicolons or parentheses |
| `writing-skills/persuasion-principles.md` | dashes used as punctuation replaced by commas, colons, semicolons or parentheses |
| `writing-skills/testing-skills-with-subagents.md` | skill references renamed to spectropowers; dashes used as punctuation replaced by commas, colons, semicolons or parentheses |

## Unchanged

11 files are byte identical to their source.

Kept as in the source on purpose: the working folders `.superpowers/` and `docs/superpowers/` that the skills and their scripts write to, and the branding of the brainstorming companion page.
