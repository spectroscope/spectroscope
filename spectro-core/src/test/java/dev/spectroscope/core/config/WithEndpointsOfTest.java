package dev.spectroscope.core.config;

import dev.spectroscope.core.mcp.McpServerConfig;
import org.junit.jupiter.api.Test;

import java.util.List;
import java.util.Set;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotEquals;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * Card 579: a provider switch takes the provider addresses from the settings
 * as they are now and everything else from the session's own config.
 */
class WithEndpointsOfTest {

    /** The four components a provider address is resolved from ({@link SpectroConfig#endpointFor}). */
    private static final Set<String> ADDRESSES =
            Set.of("baseUrl", "ollamaBaseUrl", "lmstudioBaseUrl", "llamacppBaseUrl");

    /**
     * A config whose every component carries {@code tag}, {@code flag} or
     * {@code n}, through the canonical constructor, so two configs with other
     * arguments differ in every component and a copy from the wrong one shows.
     */
    private static SpectroConfig tagged(String tag, boolean flag, int n) {
        return new SpectroConfig(
                flag ? "anthropic" : "ollama", "model-" + tag, "baseUrl-" + tag, 10_000 + n,
                flag ? "auto" : "ask", List.of("run_command:" + tag + "*"), flag ? "openai" : "gemini", flag,
                List.of(new McpServerConfig("mcp-" + tag, "cmd-" + tag, null, null, null, null)), n, flag,
                List.of(new HookConfig("*", "pre_tool_use", "echo " + tag, n)),
                "workspace-" + tag, flag ? "debug" : "info", "imageModel-" + tag, "sttModel-" + tag,
                flag ? "local" : "openai", flag ? "de" : "en", "chromeBinary-" + tag,
                "otlpEndpoint-" + tag, "otlpBasicAuth-" + tag,
                "ollamaBaseUrl-" + tag, "lmstudioBaseUrl-" + tag, "searxngUrl-" + tag,
                flag, flag,
                n + 1, n + 2, n + 3, n + 4, n + 5,
                "llamacppBaseUrl-" + tag,
                n + 6, n + 7, n + 8, n + 9, n + 10, n + 11, n + 12, n + 13,
                flag ? SpectroConfig.RTK_FILTER_ON : SpectroConfig.RTK_FILTER_OFF, n + 14,
                flag ? SpectroConfig.DESKTOP_NOTIFICATIONS_ON : SpectroConfig.DESKTOP_NOTIFICATIONS_OFF,
                flag ? SpectroConfig.TOOL_RESULT_ELISION_ON : SpectroConfig.TOOL_RESULT_ELISION_OFF,
                List.of("tools-" + tag), n + 15,
                flag ? SpectroConfig.CARE_PARAGRAPH_ON : SpectroConfig.CARE_PARAGRAPH_OFF, n + 16,
                List.of("key-" + tag),
                flag ? SpectroConfig.STT_RUNNER_CLI : SpectroConfig.STT_RUNNER_SERVER, flag,
                "codeGraphBackend-" + tag);
    }

    @Test
    void theAddressFieldsAreTheFourTheEndpointIsReadFrom() {
        assertEquals(ADDRESSES, Set.copyOf(SpectroConfig.ENDPOINT_FIELDS));
    }

    @Test
    void theFourAddressesComeFromTheSettingsAndEveryOtherComponentStays() throws Exception {
        SpectroConfig session = tagged("session", true, 7);
        SpectroConfig settings = tagged("settings", false, 30);

        SpectroConfig switched = session.withEndpointsOf(settings);

        var components = SpectroConfig.class.getRecordComponents();
        assertTrue(components.length >= 50, "reflection found " + components.length + " components");
        int fromSettings = 0;
        int fromSession = 0;
        for (var component : components) {
            String name = component.getName();
            Object own = component.getAccessor().invoke(session);
            Object now = component.getAccessor().invoke(settings);
            Object got = component.getAccessor().invoke(switched);
            assertNotEquals(own, now, "premise: the two configs differ at " + name);
            if (ADDRESSES.contains(name)) {
                assertEquals(now, got, name + " must come from the settings");
                fromSettings++;
            } else {
                assertEquals(own, got, name + " must stay the session's own");
                fromSession++;
            }
        }
        assertEquals(4, fromSettings, "all four address components were compared");
        assertEquals(components.length - 4, fromSession, "every other component was compared");
    }

    /** An ollama config with these two addresses and nothing else of note. */
    private static SpectroConfig ollamaAt(String baseUrl, String ollamaBaseUrl) {
        return new SpectroConfig(
                "ollama", "m1", baseUrl, null, "ask",
                List.of(), "openai", false, List.of(), 3, false, List.of(),
                null, "info", null, null,
                "auto", "auto", null,
                null, null,
                ollamaBaseUrl, null,
                null,
                false, false,
                1, 2, 3, 4, 5,
                null);
    }

    @Test
    void anAddressTheSettingsRemovedIsGoneAfterTheSwitch() {
        // Live check 0.15.3 D7: the restore wrote baseUrl and removed
        // ollamaBaseUrl. A merge that keeps the session's value where the
        // settings say nothing would dial the old address again.
        SpectroConfig session = ollamaAt("http://192.0.2.1:11434", "http://192.0.2.1:11434");
        SpectroConfig settings = ollamaAt("http://localhost:11434", null);
        assertEquals("192.0.2.1:11434", session.providerHost(), "premise: the session dials the old address");

        SpectroConfig switched = session.withEndpointsOf(settings).withProvider("ollama", "m2");

        assertNull(switched.ollamaBaseUrl());
        assertEquals("http://localhost:11434", switched.endpointFor("ollama"));
        assertEquals("localhost:11434", switched.providerHost());
    }
}
