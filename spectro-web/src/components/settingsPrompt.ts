// Card 381, the copy prompt: the sentence an operator pastes at an agent when a
// number cut their run and they cannot move it from this page.
//
// The branch is on KIND and on nothing else. Card 357 put eight kinds on the
// page precisely because they are not the same thing, and a flat "copy prompt
// per row" would say "change this" over a unit conversion, over a number the
// model decides per call, and over a constant that is only a restatement of
// another one. Three of those sentences would be false, and a false sentence
// that reads like a finished request is worse than no button at all.
//
// The mapping is keyed off GOVERNING_KINDS, which the drift test beside this
// file holds to the constants of Governs.Kind in Java. A ninth kind therefore
// arrives here as a missing template rather than as a row that silently draws
// nothing.
//
// No measured count is written into any sentence here or into the dictionary
// entries it reaches: a price typed into prose is the drift this house has
// watched four times.
//
// Card 413: the reader pastes the sentence at an agent in their own checkout
// of the public repository. So it names a file that checkout has, the
// configuration reference under docs/, and two keys that already exist as
// examples, and nothing from the private product home.

import { t, type Lang } from "../i18n/i18n";
import {
  governingUnitLabelKey,
  ownerSimpleName,
  type GoverningKind,
  type GoverningNumber,
} from "../state/governingNumbers";

/** The configuration reference: the user guide chapter whose "Every key" table
 *  has one row per settings key. A file of the public repository, relative to
 *  its root. */
export const CONFIG_REFERENCE_PATH = "docs/guide-assets/parts/18-ref-config-build.html";

/** The two settings keys the prompt names as the shape a new key follows. */
export const SHAPE_KEYS = ["subagentBudgetSeconds", "maxTurns"] as const;

/**
 * The dict key of the sentence a kind gets, or null when it gets none.
 *
 * PLUMBING is the one null. It governs nothing (`Governs.Kind#governs()`), so
 * there is no honest request to make about it, and a button offering one would
 * be the page telling the operator a lie it exists to expose.
 *
 * @param kind the row's classification
 * @return the dict key, or null when no button is drawn
 */
export function governingPromptKey(kind: GoverningKind): string | null {
  if (kind === "PLUMBING") return null;
  return `set.gnPrompt.${kind}`;
}

/** A qualified constant name, `Owner.CONSTANT` or longer. */
const CONSTANT_NAME = String.raw`[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*`;

/** A Java numeric literal as a unit conversion writes it: `1000L`, `1_000`. */
const NUMERIC_LITERAL = String.raw`\d[\d_]*(?:\.\d[\d_]*)?[LlFfDd]?`;

/** A named constant, bare or combined with literals: multiplied or divided
 *  (card 412), or offset by one, as `Owner.CONSTANT - 1` (card 490). */
const CONSTANT_EXPRESSION = new RegExp(String.raw`^${CONSTANT_NAME}(?:\s*[*/+-]\s*${NUMERIC_LITERAL})*$`);

/** Whether an alias restates a NAMED constant or a bare literal. A named
 *  constant counts when the alias converts its unit, as `Owner.CONSTANT *
 *  1000L` (card 412), or derives a count from it, as `Owner.CONSTANT - 1`
 *  (card 490). The two need different sentences: only the first has
 *  somewhere else to send the reader. */
function restatesAConstant(expression: string): boolean {
  return CONSTANT_EXPRESSION.test(expression.trim());
}

/**
 * The sentence to copy for one row, in the reader's language.
 *
 * @param number the registry row
 * @param lang   the UI language
 * @return the finished request, or null when the row gets no button
 */
export function governingPrompt(number: GoverningNumber, lang: Lang): string | null {
  const key = governingPromptKey(number.kind);
  if (key === null) return null;
  const vars = {
    owner: ownerSimpleName(number.owner),
    field: number.field,
    value: number.value,
    unit: t(lang, governingUnitLabelKey(number.unit)),
    key: number.key,
    expression: number.expression,
    path: CONFIG_REFERENCE_PATH,
    shapeA: SHAPE_KEYS[0],
    shapeB: SHAPE_KEYS[1],
  };
  if (number.kind === "ALIAS" && !restatesAConstant(number.expression)) {
    return t(lang, "set.gnPrompt.ALIAS_LITERAL", vars);
  }
  return t(lang, key, vars);
}
