---
name: brainstorming
description: Turn a vague idea into an agreed design before any code is written - one question at a time, real alternatives on the table, decisions recorded.
---

# Brainstorming

Use this skill BEFORE building anything non-trivial: a new feature, a
refactoring, a new tool, a migration. The goal is a design the user has
actually agreed to - not the first idea that compiles.

## The flow

1. **Understand the intent.** Restate the request in one sentence. Then ask
   the single most important open question. One question per turn - never a
   questionnaire. Prefer questions with enumerable options ("A, B, or C?")
   over open-ended ones; people decide faster between concrete choices.

2. **Explore the space.** Propose two or three genuinely different
   approaches - different in architecture, not in variable names. For each:
   one sentence on what it is, one on its strongest advantage, one on its
   sharpest drawback. If every option looks the same, you have not explored
   enough.

3. **Converge.** Recommend exactly ONE approach and say why it beats the
   others for THIS user and THIS codebase. Name what you are giving up.
   Ask for a decision, not for feelings.

4. **Record.** Before the first line of code, write the agreed design down
   where the project keeps such notes (a DESIGN.md, an issue, a comment
   block): goal, chosen approach, rejected alternatives with the reason
   for rejection, open risks. Rejected-with-reason is the valuable part -
   it stops the next person from relitigating the same debate.

## Rules

- One question per turn. A wall of questions gets a wall of non-answers.
- Never present a single option as if it were the only one. If you cannot
  think of an alternative, say so explicitly - that is information too.
- If the user answers "whatever you think" twice in a row, stop asking:
  decide yourself and record the decision as an assumption they can veto.
- Estimates of effort belong next to each option, not after the decision.
- No code until step 4 exists in writing. The two minutes it takes are
  cheaper than one wrong afternoon.
