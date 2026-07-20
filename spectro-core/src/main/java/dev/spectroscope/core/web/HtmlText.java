package dev.spectroscope.core.web;

/**
 * The shared hand-rolled HTML→text strip: drop script/style wholesale, strip
 * tags, decode a few common entities, collapse whitespace. Serves web_fetch,
 * web_search's DuckDuckGo parser and browse_page — no jsoup, so the core
 * gains no new dependency (accepting the crudeness; readable text is the goal,
 * not a DOM).
 */
public final class HtmlText {

    /** Static utility — never instantiated. */
    private HtmlText() {}

    /**
     * Reduces an HTML fragment or page to single-spaced plain text.
     *
     * @param html the raw markup; tagless input passes through (minus whitespace runs)
     * @return the readable text; possibly empty
     */
    public static String strip(String html) {
        String noScript = html.replaceAll("(?is)<script.*?</script>", " ")
                .replaceAll("(?is)<style.*?</style>", " ");
        String noTags = noScript.replaceAll("(?s)<[^>]+>", " ");
        String decoded = noTags
                .replace("&nbsp;", " ")
                .replace("&amp;", "&")
                .replace("&lt;", "<")
                .replace("&gt;", ">")
                .replace("&quot;", "\"")
                .replace("&#39;", "'");
        return decoded.replaceAll("\\s+", " ").strip();
    }
}
