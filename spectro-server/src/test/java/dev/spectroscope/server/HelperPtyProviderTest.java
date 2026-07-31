package dev.spectroscope.server;

import org.junit.jupiter.api.Test;

import java.nio.file.Path;
import java.util.List;
import java.util.Set;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * The helper-binary provider, tested where it is pure: which shell gets started,
 * with which flags, and the command line handed to {@code spectro-pty}. The
 * client never contributes any of it — the shell comes from the SERVER's own
 * environment, which is why an operator's oh-my-zsh setup shows up and why a
 * browser cannot ask for a different program.
 */
class HelperPtyProviderTest {

    /** Pretend only these paths are executable. */
    private static java.util.function.Predicate<String> only(String... paths) {
        Set<String> set = Set.of(paths);
        return set::contains;
    }

    @Test
    void theOperatorsOwnShellWins() {
        // $SHELL is where oh-my-zsh lives — that is the whole point of the card.
        assertEquals("/opt/homebrew/bin/zsh", HelperPtyProvider.resolveShell(
                "/opt/homebrew/bin/zsh", only("/opt/homebrew/bin/zsh", "/bin/zsh", "/bin/sh")));
    }

    @Test
    void withoutShellItFallsToZshThenBashThenSh() {
        assertEquals("/bin/zsh", HelperPtyProvider.resolveShell(null,
                only("/bin/zsh", "/bin/bash", "/bin/sh")));
        assertEquals("/bin/bash", HelperPtyProvider.resolveShell(null,
                only("/bin/bash", "/bin/sh")));
        assertEquals("/bin/sh", HelperPtyProvider.resolveShell(null, only("/bin/sh")));
    }

    @Test
    void aRelativeShellIsRefused() {
        // Never exec a name through PATH: an inherited PATH is attacker-shaped
        // input on a machine that has ever run an untrusted script.
        assertEquals("/bin/zsh", HelperPtyProvider.resolveShell("zsh",
                only("zsh", "/bin/zsh", "/bin/sh")));
        assertEquals("/bin/zsh", HelperPtyProvider.resolveShell("../../bin/zsh",
                only("../../bin/zsh", "/bin/zsh", "/bin/sh")));
    }

    @Test
    void aNonExecutableShellIsSkipped() {
        assertEquals("/bin/bash", HelperPtyProvider.resolveShell("/usr/local/bin/gone",
                only("/bin/bash", "/bin/sh")));
    }

    @Test
    void loginAndInteractiveForTheShellsThatReadRcFiles() {
        // -l -i is what makes .zprofile/.zshrc load; without it there is no theme.
        assertEquals(List.of("-l", "-i"), HelperPtyProvider.shellArgs("/bin/zsh"));
        assertEquals(List.of("-l", "-i"), HelperPtyProvider.shellArgs("/opt/homebrew/bin/bash"));
        assertEquals(List.of("-i"), HelperPtyProvider.shellArgs("/usr/bin/tcsh"));
    }

    @Test
    void theHelperCommandCarriesTheWindowThenTheShell() {
        assertEquals(
                List.of("/opt/app/bin/spectro-pty", "48", "200", "--", "/bin/zsh", "-l", "-i"),
                HelperPtyProvider.buildCommand("/opt/app/bin/spectro-pty", 48, 200,
                        "/bin/zsh", List.of("-l", "-i")));
    }

    @Test
    void providerKeysDoNotTravelIntoTheShell() {
        // The Gradle build loads .env into the server's own process environment. A
        // terminal the operator opened themselves would not have those keys, so a
        // browser-driven one does not either.
        java.util.Map<String, String> env = new java.util.HashMap<>();
        env.put("ANTHROPIC_API_KEY", "sk-should-not-travel");
        env.put("GEMINI_API_KEY", "also-not");
        env.put("GITHUB_TOKEN", "nope");
        env.put("SPECTRO_OTLP_BASIC_AUTH", "user:pass");
        env.put("DB_PASSWORD", "hunter2");
        env.put("aws_secret", "lower case counts too");
        env.put("PATH", "/usr/bin");
        env.put("HOME", "/Users/someone");
        env.put("ZSH", "/Users/someone/.oh-my-zsh");
        HelperPtyProvider.sanitizeEnv(env);
        assertEquals(Set.of("PATH", "HOME", "ZSH"), env.keySet(),
                "only the keys a shell legitimately needs survive");
    }

    @Test
    void withoutAHelperBinaryTheProviderIsUnavailable() {
        HelperPtyProvider none = new HelperPtyProvider(() -> null);
        assertFalse(none.available());
    }

    @Test
    void withAHelperBinaryTheProviderIsAvailable() {
        HelperPtyProvider present = new HelperPtyProvider(() -> Path.of("/opt/app/bin/spectro-pty"));
        assertTrue(present.available());
    }
}
