package dev.spectroscope.core.web;

import org.junit.jupiter.api.Test;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * The shared hand-rolled HTML→text strip (used by web_fetch, web_search's
 * DuckDuckGo parser and browse_page): drops script/style wholesale, strips
 * tags, decodes the common entities and collapses whitespace. No jsoup — the
 * core gains no dependency.
 */
class HtmlTextTest {

    @Test
    void dropsScriptAndStyleBlocksWholesale() {
        String text = HtmlText.strip(
                "<style>b{color:red}</style><script>evil()</script><p>kept</p>");
        assertEquals("kept", text);
        assertFalse(text.contains("evil"));
    }

    @Test
    void stripsTagsAndDecodesCommonEntities() {
        String text = HtmlText.strip("<b>Fish &amp; Chips</b> &lt;3 &quot;quoted&quot; &#39;q&#39;&nbsp;end");
        assertEquals("Fish & Chips <3 \"quoted\" 'q' end", text);
    }

    @Test
    void collapsesWhitespaceRunsToSingleSpaces() {
        assertEquals("a b c", HtmlText.strip("  a\n\n<b> b </b>\t c  "));
    }

    @Test
    void emptyAndTaglessInputsPassThrough() {
        assertEquals("", HtmlText.strip(""));
        assertEquals("plain", HtmlText.strip("plain"));
    }
}
