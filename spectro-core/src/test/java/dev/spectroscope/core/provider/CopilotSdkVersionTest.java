package dev.spectroscope.core.provider;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.junit.jupiter.api.Assumptions.assumeTrue;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import org.junit.jupiter.api.Test;

/**
 * Card 496: the doctor names the Copilot SDK version. It is read from the SDK
 * jar on the classpath, so it is the version that runs, and this test holds it
 * to the version catalog the build resolved it from.
 */
class CopilotSdkVersionTest {

    @Test
    void theSdkVersionIsTheOneTheBuildPinned() throws IOException {
        String running = CopilotProvider.sdkVersion().orElseThrow();
        assertTrue(running.matches("\\d+\\.\\d+\\.\\d+.*"), running);

        Path catalog = repoRoot().resolve("gradle/libs.versions.toml");
        assumeTrue(Files.exists(catalog), "not running from a source checkout");
        Matcher pinned = Pattern.compile("(?m)^copilot-sdk = \"([^\"]+)\"").matcher(Files.readString(catalog));
        assertTrue(pinned.find(), "no copilot-sdk entry in " + catalog);
        assertEquals(pinned.group(1), running);
    }

    private static Path repoRoot() {
        Path here = Path.of("").toAbsolutePath();
        while (here != null && !Files.exists(here.resolve("settings.gradle.kts"))) {
            here = here.getParent();
        }
        return here == null ? Path.of("").toAbsolutePath() : here;
    }
}
