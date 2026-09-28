// Card 448. A stock SearXNG refuses format=json, and web_search then reads the
// same instance's HTML results page. The result header says so; this module
// reads that header, so the transcript can tell the operator once per session
// that his instance serves HTML only and how to switch its JSON output on.
//
// The header is the Java side's sentence (WebSearchTool in spectro-core). Both
// sides are held to fixtures/web-search-searxng-html.txt: SearxngHtmlPageTest
// compares what the tool prints with it, and searxngHtmlNote.test.ts feeds it
// through the reducer.

/** The dictionary key of the info line. */
export const SEARXNG_HTML_NOTE_KEY = "info.searxngHtmlOnly";

/** The header web_search prints when the hits came from the HTML page. */
const HTML_PAGE_HEADER = /^Results \(searxng at (\S+), read from its HTML results page\) for "/;

/**
 * The instance address from a web_search result that was read from a SearXNG
 * instance's HTML results page.
 *
 * @param output the tool result as the model received it
 * @returns the address the header names, or null for every other result
 */
export function searxngHtmlAddress(output: string): string | null {
  const match = HTML_PAGE_HEADER.exec(output);
  return match === null ? null : match[1];
}
