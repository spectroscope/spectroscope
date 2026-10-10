package dev.spectroscope.core.config;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertSame;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import dev.spectroscope.core.copilot.CopilotRuntime;
import dev.spectroscope.core.provider.CopilotProvider;
import dev.spectroscope.core.provider.LlmProvider;
import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.attribute.PosixFilePermissions;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

/**
 * Card 496: {@code copilot} is a provider value of the config. It needs no key,
 * it signs in, and its provider is built through the machine's Copilot account
 * with the runtime the lookup of card 497 finds.
 */
class CopilotProviderConfigTest {

    @TempDir
    Path dir;

    @Test
    void copilotIsAKnownProviderAndLoadsFromTheConfig() {
        SpectroConfig config = SpectroConfig.load(
                new SpectroConfig.Overrides("copilot", "auto", null, null, null, null), dir);

        assertEquals("copilot", config.provider());
        assertTrue(SpectroConfig.isKnownProvider("copilot"));
        assertTrue(SpectroConfig.KNOWN_PROVIDERS_DISPLAY.contains("copilot"),
                "the refusal message lists every accepted name: " + SpectroConfig.KNOWN_PROVIDERS_DISPLAY);
    }

    @Test
    void anUnknownProviderNameIsStillRefused() {
        IllegalArgumentException refused = assertThrows(IllegalArgumentException.class,
                () -> SpectroConfig.load(new SpectroConfig.Overrides("copilotx", null, null, null, null, null), dir));

        assertTrue(refused.getMessage().contains("Unknown provider: \"copilotx\""), refused.getMessage());
    }

    @Test
    void copilotSignsInAndHasNoKeyNoAddressAndAnHonestDefaultModel() {
        assertTrue(SpectroConfig.signsIn("copilot"));
        assertEquals(java.util.Set.of("copilot"), SpectroConfig.signInProviders());
        assertNull(SpectroConfig.keyEnvFor("copilot"), "a sign-in is not a key");
        assertNull(SpectroConfig.presetEndpointFor("copilot"), "the runtime is a subprocess, not an address");
        assertFalse(SpectroConfig.keylessLocalServers().contains("copilot"));
        assertFalse(SpectroConfig.openAiCompatProviders().contains("copilot"));
        assertFalse(SpectroConfig.switchRequiresKey("copilot"));
        assertEquals("auto", SpectroConfig.defaultModelFor("copilot"),
                "auto is the runtime's own choice and is in every account's model list");
        for (String keyed : java.util.List.of("anthropic", "ollama", "openai", "spectro-local")) {
            assertFalse(SpectroConfig.signsIn(keyed), keyed + " does not sign in");
        }
    }

    @Test
    void theOnboardingStatusOfASignInProviderIsSignedInOrNeedsSignIn() {
        assertEquals("signed-in", SpectroConfig.onboardingStatus("copilot", true));
        assertEquals("needs-signin", SpectroConfig.onboardingStatus("copilot", false));
        // The other words stay where they were.
        assertEquals("ready", SpectroConfig.onboardingStatus("anthropic", true));
        assertEquals("needs-key", SpectroConfig.onboardingStatus("anthropic", false));
        assertEquals("local", SpectroConfig.onboardingStatus("ollama", false));
    }

    @Test
    void theCopilotProviderIsBuiltThroughTheAccountWithTheRuntimeTheLookupFinds() throws IOException {
        Path cli = executable(dir.resolve("bin").resolve("copilot"));
        CopilotRuntime.Environment mac = CopilotRuntime.Environment.builder()
                .os("Mac OS X").copilotCliPath(cli.toString()).home(dir).build();

        CopilotProvider provider = (CopilotProvider) SpectroConfig.copilotProvider("claude-sonnet-5", null, mac);

        assertEquals("copilot", provider.providerName());
        assertEquals("claude-sonnet-5", provider.options().model());
        assertEquals(cli.toRealPath().toString(), Path.of(provider.options().cliPath()).toRealPath().toString());
        assertSame(provider, SpectroConfig.copilotProvider("claude-sonnet-5", null, mac),
                "one provider per model and runtime, so a second chat does not start a second runtime");
    }

    @Test
    void offMacOsTheProviderIsRefusedWithTheLookupsReason() {
        CopilotRuntime.Environment linux = CopilotRuntime.Environment.builder().os("Linux").home(dir).build();

        IllegalStateException refused = assertThrows(IllegalStateException.class,
                () -> SpectroConfig.copilotProvider("auto", null, linux));

        assertTrue(refused.getMessage().contains("not supported on this platform"), refused.getMessage());
    }

    @Test
    void providerFromConfigHasACopilotArm() {
        SpectroConfig config = SpectroConfig.load(
                new SpectroConfig.Overrides("copilot", "auto", null, null, null, null), dir);
        try {
            LlmProvider provider = config.providerFromConfig();
            assertEquals("copilot", provider.providerName());
        } catch (IllegalStateException noRuntimeHere) {
            // A machine without the runtime, or not a Mac: the lookup's reason,
            // never "Unknown provider".
            assertTrue(noRuntimeHere.getMessage().startsWith("copilot runtime: "), noRuntimeHere.getMessage());
        }
    }

    private static Path executable(Path file) throws IOException {
        Files.createDirectories(file.getParent());
        Files.writeString(file, "#!/bin/sh\nexit 0\n");
        Files.setPosixFilePermissions(file, PosixFilePermissions.fromString("rwxr-xr-x"));
        return file;
    }
}
