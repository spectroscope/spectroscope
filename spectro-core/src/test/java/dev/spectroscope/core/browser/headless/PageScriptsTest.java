package dev.spectroscope.core.browser.headless;

import org.junit.jupiter.api.Test;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * The injected page scripts, ported from the desktop's {@code pageScript.ts}
 * (card 226). The port is asserted on the properties a drift would break:
 * the shared {@code __spectroRefs} contract that makes a ref from read usable
 * by find and click, and the literal escaping that keeps model output from
 * breaking out of a script string.
 */
class PageScriptsTest {

    @Test
    void theThreeScriptsShareTheRefContract() {
        assertTrue(PageScripts.readPage("interactive", 8000).contains("window.__spectroRefs"),
                "read must publish the refs the other two consume");
        assertTrue(PageScripts.find("the search box").contains("window.__spectroRefs"));
        assertTrue(PageScripts.refRect("ref_3").contains("__spectroRefs"));
        assertTrue(PageScripts.find("x").contains("NO_TREE"),
                "find must say NO_TREE before any read, so the tool can name the fix");
    }

    @Test
    void modelOutputIsEscapedIntoTheScriptNotSplicedIn() {
        String query = "\"); document.title='pwned'; (\"";
        String script = PageScripts.find(query);
        // The whole query must arrive as ONE JSON string literal — the interior
        // quotes escaped, so the parenthesis after them cannot close anything.
        String literal = "\"\\\"); document.title='pwned'; (\\\"\"";
        assertTrue(script.contains(literal),
                "the query must be embedded as an escaped JSON literal: " + script);
        assertFalse(script.contains("(" + query + ")"),
                "the raw, unescaped query must never be spliced in as code");
    }

    @Test
    void theCapIsBoundedBelowSoAHostileMaxCharsCannotZeroTheTree() {
        assertTrue(PageScripts.readPage("all", -5).contains("500"),
                "the floor of 500 characters holds even for a negative cap");
    }

    @Test
    void aRefIsReadAsItsNumberInEitherSpelling() {
        assertEquals(PageScripts.refRect("ref_7"), PageScripts.refRect("ref_7"));
        assertTrue(PageScripts.refRect("7").contains("\"7\""));
        assertTrue(PageScripts.refRect("ref_7").contains("\"ref_7\""));
    }
}
