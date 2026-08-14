---
name: research
description: Web research with a method - pick the depth, search in angles, verify before citing, and answer with sources. Use it whenever the task is to research, compare, evaluate or fact-find ("research X", "compare A vs B", "what is better for...", "is it worth...", "does X still work"), even when the word research is absent.
---

# Research

Use this skill when the task is to FIND OUT something the workspace cannot
answer: facts, comparisons, feasibility, state of the art. Your value is an
answer somebody can check - every claim carries its source, and the depth
matches the ask. Answer in the user's language, whatever language the
sources are in.

## Depth first (always)

Decide the mode before the first search, and say which one you picked:

| mode | signal | output |
|---|---|---|
| `quick` | a comparison or fact question ("which is better", "can X do Y") | the answer in the session: a compact table plus source links, no files |
| `normal` | "research X", "build a knowledge base" | a structured memo: findings in themed blocks, each claim tagged with its source |
| `deep` | "deep", "thorough", many named subtopics | like `normal` with more angles, more sources, and one verification round per load-bearing claim |

The escalation ladder: when in doubt, start small and OFFER the bigger
package in one sentence. Never build the full memo unasked when a table
answers the question.

## The tools, and when to climb

- **web_search** finds candidates. It runs on whatever search tier is
  configured; the result header names the tier, and a best-effort tier means
  results can be thin - say so rather than padding.
- **web_fetch** reads a page as text. Use it on every source you cite:
  a search snippet is a teaser, not a source.
- **browse_page** renders a page in a real browser. Climb to it only when
  web_fetch comes back empty or mangled (script-heavy pages) - it is the
  expensive rung.

Each of these is permission-gated. A refused call is an answer, not an
obstacle: work with what you have and mark the gap.

## Query strategy

1. Split the topic into 3-5 search angles: broad/primary, technical,
   practitioner experience, current state, plus whatever the topic itself
   suggests. One angle per web_search call, precise terms over long prose.
2. Read the 2-4 best hits per angle with web_fetch. Prefer the primary
   source (official docs, the vendor's page, the paper) over posts about it.
3. Extract the checkable statements - numbers, versions, formulas verbatim,
   never paraphrased into vagueness. What has no source gets dropped or is
   marked as an assumption.

## Source triage - honest tiers

Grade every source and show the grade:

- **[P]** primary: official documentation, standards, papers, the vendor.
- **[B]** practitioner: blogs, talks, experience reports.
- **[U]** unverified: forums, hearsay, anything you could not open. Usable
  as a pointer, never as the sole support of a claim.

## Verify before citing

- Cross-check every load-bearing claim (anything a recommendation rests on)
  against a second, independent source. In `deep` mode, search for the
  refutation, not the confirmation.
- Contradictions between sources go INTO the answer as contradictions.
  Resolving them by picking the nicer one is fabrication.
- Never guess a URL, a number or a version. Missing data is "n/a", not an
  estimate; estimates are labeled as estimates.
- Anything you know only from memory that matters to the verdict: verify it
  from the web or label it unverified.

## Presenting findings

- `quick`: a table of the facts (with "n/a" where sources are silent), a
  short weighted recommendation for THIS user's case, and the source links.
- `normal` and `deep`: themed sections, every claim tagged [S1], [S2], ...,
  and a closing source register (id, tier, title, URL). End with what is
  still open - an honest gap beats a padded answer.
- Deliverables become files only when the user asked for files AND you have
  a write tool; a research child often runs read-only, and then your final
  text IS the deliverable - make it complete on its own.

## Report while you work

If a report_status tool is available, report one short sentence per
milestone ("angles searched, verifying the two load-bearing claims next").
