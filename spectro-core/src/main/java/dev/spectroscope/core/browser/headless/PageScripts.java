package dev.spectroscope.core.browser.headless;

import com.fasterxml.jackson.core.io.JsonStringEncoder;

/**
 * The scripts the web face injects into the page it is driving — the Java port
 * of the desktop's {@code pageScript.ts} (card 226).
 *
 * <p>Everything here runs in the PAGE context ({@code Runtime.evaluate}), the
 * same place {@code browser_eval} runs, and for the same reason: an isolated
 * world has the same DOM and none of the page's own globals, which is exactly
 * the "close enough" failure card 200 section 3 names.
 *
 * <p><b>Two copies exist and that is a known cost, not an accident.</b> The
 * desktop's scripts are TypeScript template functions and this file mirrors
 * them; a change on one side must be carried to the other by hand, and the
 * card's disclosure names it. The one contract the two must share is the
 * {@code window.__spectroRefs} array — a tree read on either face hands out
 * {@code ref_N} handles that the click and the find of the SAME face resolve,
 * so the array's name and 1-based indexing are the whole interface.
 */
final class PageScripts {

    private PageScripts() {
    }

    /** Model output as a JSON string literal — never spliced in as code.
     *  @param value the untrusted text
     *  @return the quoted, escaped literal */
    private static String literal(String value) {
        return "\"" + new String(JsonStringEncoder.getInstance()
                .quoteAsString(String.valueOf(value))) + "\"";
    }

    /**
     * The accessibility-tree reader.
     *
     * @param filter   "interactive" for the elements that can be acted on, "all" for structure too
     * @param maxChars the cap on the returned tree, floored at 500
     * @return the script
     */
    static String readPage(String filter, int maxChars) {
        return "(() => {\n"
                + "  const INTERACTIVE = 'a[href],button,input,select,textarea,summary,"
                + "[role=button],[role=link],[role=tab],[role=checkbox],[role=menuitem],"
                + "[contenteditable=true],[onclick],[tabindex]:not([tabindex=\"-1\"])';\n"
                + "  const STRUCTURE = 'h1,h2,h3,h4,h5,h6,main,nav,form,table,label,li,p,article,"
                + "section,[role=heading],[role=alert],[role=status]';\n"
                + "  const wanted = " + literal(filter) + " === 'all' "
                + "? INTERACTIVE + ',' + STRUCTURE : INTERACTIVE;\n"
                + "  const seen = Array.from(document.querySelectorAll(wanted));\n"
                + "  const refs = [];\n"
                + "  const lines = [];\n"
                + "  const visible = (el) => {\n"
                + "    const r = el.getBoundingClientRect();\n"
                + "    if (r.width === 0 && r.height === 0) return false;\n"
                + "    const s = getComputedStyle(el);\n"
                + "    return s.visibility !== 'hidden' && s.display !== 'none';\n"
                + "  };\n"
                + "  const name = (el) => {\n"
                + "    const label = el.getAttribute('aria-label') || el.getAttribute('title')\n"
                + "      || el.getAttribute('placeholder') || el.getAttribute('alt') || '';\n"
                + "    const text = (el.innerText || el.value || '').trim().replace(/\\s+/g, ' ');\n"
                + "    return (label || text).slice(0, 120);\n"
                + "  };\n"
                + "  const role = (el) => el.getAttribute('role') || el.tagName.toLowerCase();\n"
                + "  const depth = (el) => { let d = 0, p = el.parentElement; "
                + "while (p && d < 12) { d++; p = p.parentElement; } return d; };\n"
                + "  const base = seen.length "
                + "? Math.min(...seen.filter(visible).map(depth)) : 0;\n"
                + "  for (const el of seen) {\n"
                + "    if (!visible(el)) continue;\n"
                + "    refs.push(el);\n"
                + "    const indent = '  '.repeat(Math.max(0, Math.min(8, depth(el) - base)));\n"
                + "    const label = name(el);\n"
                + "    const extra = el.disabled ? ' disabled' "
                + ": (el.checked === true ? ' checked' : '');\n"
                + "    lines.push(indent + '- ' + role(el) + (label ? ' \"' + label + '\"' : '')\n"
                + "      + extra + ' [ref_' + refs.length + ']');\n"
                + "  }\n"
                + "  window.__spectroRefs = refs;\n"
                + "  const head = 'title: ' + JSON.stringify(document.title) + '\\nurl: ' "
                + "+ location.href + '\\nelements: ' + refs.length + '\\n';\n"
                + "  const body = lines.join('\\n');\n"
                + "  const cap = " + Math.max(500, maxChars) + ";\n"
                + "  return head + (body.length > cap ? body.slice(0, cap) + '\\n… (' "
                + "+ (body.length - cap) + ' more characters; narrow the filter)' : body);\n"
                + "})()";
    }

    /**
     * The finder — searches the tree the last read produced.
     *
     * @param query what the model is looking for, in its own words
     * @return the script
     */
    static String find(String query) {
        return "(() => {\n"
                + "  const refs = window.__spectroRefs;\n"
                + "  if (!refs || !refs.length) return 'NO_TREE';\n"
                + "  const words = " + literal(query) + ".toLowerCase()"
                + ".split(/[^a-z0-9]+/i).filter(w => w.length > 1);\n"
                + "  const describe = (el) => {\n"
                + "    const label = el.getAttribute('aria-label') || el.getAttribute('title')\n"
                + "      || el.getAttribute('placeholder') || el.getAttribute('alt') || '';\n"
                + "    const text = (el.innerText || el.value || '').trim().replace(/\\s+/g, ' ');\n"
                + "    return ((el.getAttribute('role') || el.tagName.toLowerCase()) + ' ' + label "
                + "+ ' ' + text + ' ' + (el.id || '') + ' ' + (el.className || '')).toLowerCase();\n"
                + "  };\n"
                + "  const scored = refs.map((el, i) => {\n"
                + "    const hay = describe(el);\n"
                + "    let score = 0;\n"
                + "    for (const w of words) if (hay.includes(w)) score++;\n"
                + "    return { i: i + 1, score, hay: hay.trim().slice(0, 120) };\n"
                + "  }).filter(m => m.score > 0).sort((a, b) => b.score - a.score).slice(0, 20);\n"
                + "  if (!scored.length) return '';\n"
                + "  return scored.map(m => 'ref_' + m.i + '  ' + m.hay).join('\\n');\n"
                + "})()";
    }

    /**
     * Where a ref is on screen right now, after scrolling it into view.
     *
     * @param ref the handle, {@code ref_3} or {@code 3}
     * @return the script, resolving to {@code {x, y}} or {@code null}
     */
    static String refRect(String ref) {
        return "(() => {\n"
                + "  const n = parseInt(String(" + literal(ref) + ").replace(/^ref_/, ''), 10);\n"
                + "  const refs = window.__spectroRefs || [];\n"
                + "  const el = refs[n - 1];\n"
                + "  if (!el) return null;\n"
                + "  el.scrollIntoView({ block: 'center', inline: 'center' });\n"
                + "  const r = el.getBoundingClientRect();\n"
                + "  return { x: Math.round(r.left + r.width / 2), "
                + "y: Math.round(r.top + r.height / 2) };\n"
                + "})()";
    }

    /** What the page is asked about itself once emulation overrides are in. */
    static final String MEASURE = "({ innerWidth: window.innerWidth, "
            + "innerHeight: window.innerHeight, "
            + "screenWidth: window.screen.width, screenHeight: window.screen.height, "
            + "maxTouchPoints: navigator.maxTouchPoints, "
            + "devicePixelRatio: window.devicePixelRatio, "
            + "coarsePointer: window.matchMedia('(pointer: coarse)').matches, "
            + "viewportMeta: !!document.querySelector('meta[name=\"viewport\"]') })";
}
