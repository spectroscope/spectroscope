package dev.spectroscope.server.session;

import dev.spectroscope.core.config.SpectroConfig;
import dev.spectroscope.core.web.WebSearchTiers;
import org.junit.jupiter.api.Test;

import java.util.Map;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * The settings page's window onto the search tier (card 203).
 *
 * <p>The page cannot re-derive the tier in TypeScript — that would be a third
 * copy of the rule the card just collapsed into one. So {@code /api/config}
 * reports what {@link WebSearchTiers} decided on this machine, and the page
 * renders it. This test holds the report to the resolver's own answer rather
 * than to a literal, which is the only version of the assertion that keeps
 * meaning something after somebody edits either side.</p>
 *
 * <p>Keys are reported as PRESENCE, never as values — same rule as the LLM
 * provider block right above it in the same response.</p>
 */
class ConfigWebSearchTierTest {

    @Test
    @SuppressWarnings("unchecked")
    void theTierReportedIsTheTierTheResolverDecided() {
        Map<String, Object> config = new SessionsController().config();
        Map<String, Object> webSearch = (Map<String, Object>) config.get("webSearch");
        assertNotNull(webSearch, "the settings page needs the active tier from the server");

        WebSearchTiers.Choice expected = WebSearchTiers.forConfig(
                SpectroConfig.load(SpectroConfig.Overrides.none()));
        assertEquals(expected.tier(), webSearch.get("tier"));
        assertEquals(WebSearchTiers.label(expected.tier()), webSearch.get("label"),
                "the label travels too — the page must not rebuild the apology itself");
        assertEquals(WebSearchTiers.describe(expected), webSearch.get("detail"));
    }

    @Test
    @SuppressWarnings("unchecked")
    void theKeysAreReportedAsPresenceAndNeverAsValues() {
        Map<String, Object> config = new SessionsController().config();
        Map<String, Object> webSearch = (Map<String, Object>) config.get("webSearch");

        for (String field : java.util.List.of("tavilyKey", "braveKey")) {
            Object value = webSearch.get(field);
            assertNotNull(value, field + " must be reported");
            assertTrue("true".equals(value) || "false".equals(value),
                    field + " is a presence flag, got: " + value);
        }
        // Nothing in this block may carry a secret. The whole serialized map is
        // checked rather than the two named fields, so a later addition cannot
        // smuggle one in beside them.
        String serialized = String.valueOf(webSearch);
        assertFalse(serialized.contains("tvly-"), "a Tavily key shape leaked: " + serialized);
        assertFalse(serialized.contains("BSA"), "a Brave key shape leaked: " + serialized);
    }

    @Test
    @SuppressWarnings("unchecked")
    void theSavedInstanceAddressTravelsBecauseTheFieldHasToShowIt() {
        Map<String, Object> config = new SessionsController().config();
        Map<String, Object> webSearch = (Map<String, Object>) config.get("webSearch");
        String configured = SpectroConfig.load(SpectroConfig.Overrides.none()).searxngUrl();
        assertEquals(configured == null ? "" : configured, webSearch.get("searxngUrl"),
                "an address is not a credential; the field prefills from it");
    }

    @Test
    void theTwoSearchProvidersHaveAKeyVariableAndAreNotLlmBackends() {
        // The settings page posts to the SAME /api/onboarding/key endpoint the
        // LLM providers use, so these two names have to resolve to a key
        // variable there. They must NOT become LLM providers on the way in:
        // a "tavily" entry in the model picker would be a conversation nobody
        // can have.
        assertEquals("TAVILY_API_KEY", SpectroConfig.searchKeyEnvFor("tavily"));
        assertEquals("BRAVE_API_KEY", SpectroConfig.searchKeyEnvFor("brave"));
        assertFalse(SpectroConfig.isKnownProvider("tavily"), "not an LLM backend");
        assertFalse(SpectroConfig.isKnownProvider("brave"), "not an LLM backend");
        assertEquals(null, SpectroConfig.keyEnvFor("tavily"),
                "the LLM vocabulary stays clean");
    }
}
