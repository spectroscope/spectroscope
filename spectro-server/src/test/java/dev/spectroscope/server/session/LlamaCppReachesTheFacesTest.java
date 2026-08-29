package dev.spectroscope.server.session;

import dev.spectroscope.core.config.SpectroConfig;
import org.junit.jupiter.api.Test;

import java.lang.reflect.Method;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Map;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * Card 312: what {@code /api/config} tells the faces about llamacpp.
 *
 * <p>Two maps in that payload are read by the UI and neither is derived from
 * {@link SpectroConfig#knownProviders()} — both are hand-written lists. A
 * provider missing from {@code providerStatus} gets no onboarding line; one
 * missing from {@code providerAddress} makes the picker's "backend not
 * reachable" sentence fall back to the addressless wording, which is the exact
 * guess card 193 removed.</p>
 */
class LlamaCppReachesTheFacesTest {

    @Test
    void theModelListRouteAnswersForLlamacpp() throws Exception {
        // A provider the route does not know answers List.of() — which the
        // picker renders as "not reachable" no matter what the server does.
        Method models = SessionsController.class.getDeclaredMethod("models", String.class);
        assertNotNull(models);
        String source = readSource("SessionsController.java");
        assertTrue(source.contains("\"openai\", \"lmstudio\", \"llamacpp\", \"openrouter\", \"gemini\""),
                "llamacpp speaks the same /v1/models wire as its openai-compatible "
                        + "neighbours and belongs in that arm of the switch");
    }

    @Test
    void theOnboardingStatusListCarriesLlamacpp() throws Exception {
        String source = readSource("SessionsController.java");
        int start = source.indexOf("Map<String, String> providerStatus");
        int end = source.indexOf("out.put(\"providerStatus\"", start);
        assertTrue(start > 0 && end > start, "the providerStatus block moved");
        assertTrue(source.substring(start, end).contains("\"llamacpp\""),
                "without a status entry the picker shows llamacpp no onboarding line");
    }

    @Test
    void theAddressMapCarriesLlamacpp() throws Exception {
        String source = readSource("SessionsController.java");
        int start = source.indexOf("Map<String, String> providerAddress");
        int end = source.indexOf("out.put(\"providerAddress\"", start);
        assertTrue(start > 0 && end > start, "the providerAddress block moved");
        assertTrue(source.substring(start, end).contains("endpointFor(\"llamacpp\")"),
                "the unreachable sentence must be able to name the address that was "
                        + "actually dialled, not fall back to the addressless wording");
    }

    @Test
    void llamacppReportsItselfAsLocalRatherThanNeedingAKey() {
        // Bitten apart from the map test above: a provider could be listed and
        // still be classified as a keyed cloud service.
        assertEquals("local", SpectroConfig.onboardingStatus("llamacpp", false));
    }

    @Test
    void aLiveProviderSwitchAcceptsLlamacpp() {
        // SessionConnection refuses any provider SpectroConfig does not know.
        assertTrue(SpectroConfig.isKnownProvider("llamacpp"));
        assertEquals("local-model", SpectroConfig.defaultModelFor("llamacpp"));
    }

    private static String readSource(String name) throws Exception {
        Path here = Path.of("src/main/java/dev/spectroscope/server/session").resolve(name);
        Path fromRoot = Path.of("spectro-server").resolve(here);
        return Files.readString(Files.exists(here) ? here : fromRoot);
    }
}
