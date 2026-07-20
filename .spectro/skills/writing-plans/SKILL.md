---
name: writing-plans
description: Turn an agreed design into a step-by-step implementation plan a fresh engineer could execute - exact files, verifiable steps, no open questions.
---

# Writing plans

Use this skill when a design exists (or the task is clear enough to skip one)
and the next artifact is a PLAN: the ordered list of concrete steps that turns
the idea into working code. Assume the reader is competent but knows nothing
about this codebase - the plan must stand alone.

## What a good plan looks like

- **Header first**: goal in two sentences, the chosen approach in three,
  and what is explicitly OUT of scope.
- **Steps are small and verifiable.** Each step names the exact files to
  touch, what changes in them, and how to PROVE the step worked (a command
  to run, a test that goes green, an observable behavior). A step without a
  verification line is not done being written.
- **Order carries meaning.** Earlier steps unlock later ones; say so.
  Tests come before or with the code they verify, never as a final step.
- **Full paths, real names.** "src/state/stepper.ts" - never "the stepper
  file". Quote the actual function/record/tool names.
- **No open questions.** If you hit a decision the task does not answer,
  STOP and put the question at the top of your result instead of guessing.

## The flow

1. Read the task and every file it names. List what you actually saw -
   not what you expected.
2. Draft the step list top-down (headers only), then fill each step in.
3. Re-read as the fresh engineer: can each step be executed without asking
   anything? If not, fix the step, not the reader.
4. Save the plan as a markdown file (docs/plans/ or where the task says)
   and report its path plus a one-paragraph summary as your final memo.

## Report while you work

Call report_status at each milestone: after the reading pass, after the
draft, when the file is written. One short sentence each.
