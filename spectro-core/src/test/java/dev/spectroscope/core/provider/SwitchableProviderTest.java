package dev.spectroscope.core.provider;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNull;

import dev.spectroscope.core.provider.LlmProvider.PTextDelta;
import dev.spectroscope.core.provider.LlmProvider.ProviderEvent;
import dev.spectroscope.core.provider.LlmProvider.ProviderRequest;
import java.util.List;
import org.junit.jupiter.api.Test;

class SwitchableProviderTest {

    /** A minimal provider that emits one text delta carrying a marker. */
    private static LlmProvider fixed(String marker) {
        return request -> List.of(new PTextDelta(marker));
    }

    private static String firstText(LlmProvider provider) {
        ProviderEvent event = provider
                .stream(new ProviderRequest("", List.of(), List.of(), 100, null))
                .iterator()
                .next();
        return ((PTextDelta) event).text();
    }

    @Test
    void delegatesToTheInitialProviderAndReportsItsName() {
        SwitchableProvider sw = new SwitchableProvider(fixed("A"), "anthropic");
        assertEquals("A", firstText(sw));
        assertEquals("anthropic", sw.providerName());
    }

    @Test
    void swapRedirectsBothTheStreamAndTheName() {
        SwitchableProvider sw = new SwitchableProvider(fixed("A"), "anthropic");
        sw.swap(fixed("B"), "ollama");
        assertEquals("B", firstText(sw));
        assertEquals("ollama", sw.providerName());
    }

    @Test
    void plainProvidersReportNoNameSoTheAgentFallsBack() {
        assertNull(fixed("x").providerName()); // default-method contract
    }
}
