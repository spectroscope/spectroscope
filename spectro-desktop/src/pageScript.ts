// The scripts the pane injects into the page it is driving.
//
// Everything here runs in the PAGE context (webContents.executeJavaScript), the
// same place browser_eval runs, and for the same reason: an isolated world has
// the same DOM and none of the page's own globals, which is exactly the
// "close enough" failure card 200 section 3 names.
//
// Two things earn their keep here rather than in the model's own eval:
//
//   the tree     browser_read_page is the DEFAULT output mode, because a text
//                snapshot costs a few hundred tokens and a screenshot costs a
//                picture per turn. Vision stays opt-in.
//   the handles  ref_N survives a repaint in a way a coordinate does not. The
//                page keeps the array, so a click by ref resolves to whatever
//                that element is NOW, not to where it was when it was read.

/** How JSON goes into a script literal safely — the query is model output. */
function literal(value: string): string {
  return JSON.stringify(String(value));
}

/**
 * The accessibility-tree reader.
 *
 * @param filter   "interactive" for the elements that can be acted on, "all" for structure too
 * @param maxChars the cap on the returned tree
 */
export function readPageScript(filter: string, maxChars: number): string {
  return `(() => {
  const INTERACTIVE = 'a[href],button,input,select,textarea,summary,[role=button],[role=link],[role=tab],[role=checkbox],[role=menuitem],[contenteditable=true],[onclick],[tabindex]:not([tabindex="-1"])';
  const STRUCTURE = 'h1,h2,h3,h4,h5,h6,main,nav,form,table,label,li,p,article,section,[role=heading],[role=alert],[role=status]';
  const wanted = ${literal(filter)} === 'all' ? INTERACTIVE + ',' + STRUCTURE : INTERACTIVE;
  const seen = Array.from(document.querySelectorAll(wanted));
  const refs = [];
  const lines = [];
  const visible = (el) => {
    const r = el.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) return false;
    const s = getComputedStyle(el);
    return s.visibility !== 'hidden' && s.display !== 'none';
  };
  const name = (el) => {
    const label = el.getAttribute('aria-label') || el.getAttribute('title')
      || el.getAttribute('placeholder') || el.getAttribute('alt') || '';
    const text = (el.innerText || el.value || '').trim().replace(/\\s+/g, ' ');
    return (label || text).slice(0, 120);
  };
  const role = (el) => el.getAttribute('role') || el.tagName.toLowerCase();
  const depth = (el) => { let d = 0, p = el.parentElement; while (p && d < 12) { d++; p = p.parentElement; } return d; };
  const base = seen.length ? Math.min(...seen.filter(visible).map(depth)) : 0;
  for (const el of seen) {
    if (!visible(el)) continue;
    refs.push(el);
    const indent = '  '.repeat(Math.max(0, Math.min(8, depth(el) - base)));
    const label = name(el);
    const extra = el.disabled ? ' disabled' : (el.checked === true ? ' checked' : '');
    lines.push(indent + '- ' + role(el) + (label ? ' "' + label + '"' : '')
      + extra + ' [ref_' + refs.length + ']');
  }
  window.__spectroRefs = refs;
  const head = 'title: ' + JSON.stringify(document.title) + '\\nurl: ' + location.href
    + '\\nelements: ' + refs.length + '\\n';
  const body = lines.join('\\n');
  const cap = ${Math.max(500, Math.floor(maxChars))};
  return head + (body.length > cap ? body.slice(0, cap) + '\\n… (' + (body.length - cap) + ' more characters; narrow the filter)' : body);
})()`;
}

/**
 * The finder. Searches the tree the last read produced, so a ref it hands back
 * is a ref the page still holds.
 *
 * @param query what the model is looking for, in its own words
 */
export function findScript(query: string): string {
  return `(() => {
  const refs = window.__spectroRefs;
  if (!refs || !refs.length) return 'NO_TREE';
  const words = ${literal(query)}.toLowerCase().split(/[^a-z0-9]+/i).filter(w => w.length > 1);
  const describe = (el) => {
    const label = el.getAttribute('aria-label') || el.getAttribute('title')
      || el.getAttribute('placeholder') || el.getAttribute('alt') || '';
    const text = (el.innerText || el.value || '').trim().replace(/\\s+/g, ' ');
    return ((el.getAttribute('role') || el.tagName.toLowerCase()) + ' ' + label + ' ' + text
      + ' ' + (el.id || '') + ' ' + (el.className || '')).toLowerCase();
  };
  const scored = refs.map((el, i) => {
    const hay = describe(el);
    let score = 0;
    for (const w of words) if (hay.includes(w)) score++;
    return { i: i + 1, score, hay: hay.trim().slice(0, 120) };
  }).filter(m => m.score > 0).sort((a, b) => b.score - a.score).slice(0, 20);
  if (!scored.length) return '';
  return scored.map(m => 'ref_' + m.i + '  ' + m.hay).join('\\n');
})()`;
}

/**
 * Where a ref is on screen right now, after scrolling it into view.
 *
 * <p>Resolved in the page rather than remembered in the shell, because between
 * the read and the click the page may have scrolled, re-rendered or animated.
 * A coordinate captured earlier would click whatever moved into that spot.
 *
 * @param ref the handle, "ref_3" or "3"
 */
export function refRectScript(ref: string): string {
  return `(() => {
  const n = parseInt(String(${literal(ref)}).replace(/^ref_/, ''), 10);
  const refs = window.__spectroRefs || [];
  const el = refs[n - 1];
  if (!el) return null;
  el.scrollIntoView({ block: 'center', inline: 'center' });
  const r = el.getBoundingClientRect();
  return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
})()`;
}

/**
 * A marker the guard test looks for, proving the eval really landed in the page
 * context rather than in an isolated world.
 */
export const PAGE_CONTEXT_PROBE = "typeof window.__spectroRefs";
