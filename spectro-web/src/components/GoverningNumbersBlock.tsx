// Card 357: the numbers that govern a run, made visible. The owner's ask, in
// his words: "all diese geheimen settings bitte sichtbar machen mit
// erläuterung" — make all these secret settings visible, with an explanation.
//
// The card was written believing those numbers were unexamined guesses. A
// measurer refuted that before a line was built: of the 76 constants with no
// override path, 58 carry a written reason and 5 cite a measurement, and only
// ONE says in its own words that nobody measured it. THE GAP WAS NEVER
// THOUGHT, IT WAS REACH — the reasoning existed, carefully, inside a .java
// file, and not one of the 76 stated its value anywhere in the 650 KB of
// published guide.
//
// So this block writes no explanations. Every word under every number is the
// javadoc that already stands above the constant, lifted by the scan and
// carried here over /api/governing-numbers. The only prose this file owns is
// the meaning of the KINDS, and even that lives in the dictionary rather than
// inline, so the room cannot say something the taxonomy does not.
//
// It also does not make anything settable. Turning a specific number into a
// control is a card of its own each time, with its own measurement — which is
// exactly the discipline this page exists to expose.

import { useEffect, useMemo, useState } from "react";
import { t, type Lang } from "../i18n/i18n";
import {
  fetchGoverningNumbers,
  filterGoverningNumbers,
  governs,
  governingKindLabelKey,
  governingKindWhyKey,
  governingUnitLabelKey,
  groupGoverningNumbers,
  ownerSimpleName,
  readableValue,
  type GoverningNumber,
} from "../state/governingNumbers";

/** One number: what it is called, what it is worth, and the code's own words
 *  about it. Nothing here is written for the page. */
function GoverningNumberRow({ number, lang }: { number: GoverningNumber; lang: Lang }) {
  const readable = readableValue(number);
  return (
    <li className="gn-row">
      <div className="gn-head">
        <code className="gn-name">
          {ownerSimpleName(number.owner)}.{number.field}
        </code>
        <span className="gn-value" title={number.owner}>
          {number.value}
          {readable ? <span className="gn-readable"> ({readable})</span> : null}
        </span>
        <span className="gn-unit">{t(lang, governingUnitLabelKey(number.unit))}</span>
        {/* The initializer, but only when it says something the decimal does
            not: `64L * 1024 * 1024` is a choice a reader can follow, `4` is
            the same character twice. */}
        {number.expression !== "" && number.expression !== number.value ? (
          <code className="gn-expr">{number.expression}</code>
        ) : null}
        {number.key !== "" ? (
          <span className="gn-key">
            {t(lang, "set.gnKey")} <code>{number.key}</code>
          </span>
        ) : null}
      </div>
      {number.explanation.split("\n\n").map((paragraph, at) => (
        <p className="gn-why" key={at}>
          {paragraph}
        </p>
      ))}
    </li>
  );
}

/**
 * The list itself, as a PURE function of what it was handed — no fetch, no
 * state. Split out from the block below for one reason: a component that
 * fetches in an effect cannot be server-rendered, and this suite has no DOM.
 * The whole point of this card is that the page draws the registry and not a
 * table of its own, so the thing worth testing is exactly this function, fed
 * the real generated registry.
 *
 * Groups by kind, in the order the vocabulary declares, with the kinds that
 * govern nothing standing apart under their own headings — so the exclusion is
 * visible AS DATA rather than a silent omission a reader has to take on trust
 * (card 357 criterion 6).
 *
 * @param props.numbers the registry, or the part of it a filter left standing
 * @param props.lang    the reader's language
 */
export function GoverningNumbersList({ numbers, lang }: { numbers: readonly GoverningNumber[]; lang: Lang }) {
  const groups = groupGoverningNumbers(numbers);
  if (groups.length === 0) {
    return <p className="settings-note gn-empty">{t(lang, "set.gnNoMatch")}</p>;
  }
  return (
    <>
      {groups.map((group) => (
        <section className="gn-group" key={group.kind}>
          <h4 className="gn-kind">
            {t(lang, governingKindLabelKey(group.kind))}
            <span className="gn-count">{group.numbers.length}</span>
          </h4>
          <p className="settings-note gn-kind-why">{t(lang, governingKindWhyKey(group.kind))}</p>
          <ul className="gn-list">
            {group.numbers.map((number) => (
              <GoverningNumberRow key={`${number.owner}#${number.field}`} number={number} lang={lang} />
            ))}
          </ul>
        </section>
      ))}
    </>
  );
}

/**
 * The block the settings page mounts: the fetch, the filter box, and the list
 * above.
 *
 * @param props.lang the reader's language
 */
export function GoverningNumbersBlock({ lang }: { lang: Lang }) {
  const [numbers, setNumbers] = useState<GoverningNumber[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [query, setQuery] = useState("");

  useEffect(() => {
    let alive = true;
    void fetchGoverningNumbers().then(
      (read) => {
        if (alive) setNumbers(read);
      },
      () => {
        if (alive) setFailed(true);
      },
    );
    return () => {
      alive = false;
    };
  }, []);

  const shown = useMemo(() => filterGoverningNumbers(numbers ?? [], query), [numbers, query]);
  const governingCount = (numbers ?? []).filter((number) => governs(number.kind)).length;

  if (failed) {
    return <p className="settings-note gn-empty">{t(lang, "set.gnFailed")}</p>;
  }
  if (numbers === null) {
    return <p className="settings-note gn-empty">{t(lang, "set.gnLoading")}</p>;
  }

  return (
    <div className="gn">
      <p className="settings-note">
        {t(lang, "set.gnNote", { governing: governingCount, all: numbers.length })}
      </p>
      <label className="settings-field gn-filter">
        <span>{t(lang, "set.gnFilter")}</span>
        <input
          type="search"
          value={query}
          placeholder={t(lang, "set.gnFilterHint")}
          onChange={(e) => setQuery(e.target.value)}
        />
      </label>
      <GoverningNumbersList numbers={shown} lang={lang} />
    </div>
  );
}
