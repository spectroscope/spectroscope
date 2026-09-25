// The count on the trace tab (card 435, review finding 2, 2026-09-25).
//
// A stored session knows its count only once its llm-wire index is in, which
// is after the chat has rendered. Until then the chip is drawn hidden
// (styles/graph.css), as wide as the archive's least count, so the tabs to its
// right keep their place when the number arrives. The digits are in the same
// mono face as the number, so the widths match whenever the final count has
// as many digits as the least count.

export function TraceTabCount(props: { count: number | null; least: number }) {
  const { count, least } = props;
  if (count !== null) {
    return count > 0 ? (
      <span className="tab-count tabular" aria-label={`${count} frames`}>
        {count}
      </span>
    ) : null;
  }
  if (least <= 0) return null;
  return (
    <span className="tab-count tabular tab-count--pending" aria-hidden="true">
      {"0".repeat(String(least).length)}
    </span>
  );
}
