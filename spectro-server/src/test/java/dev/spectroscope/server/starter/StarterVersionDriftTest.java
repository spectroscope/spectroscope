package dev.spectroscope.server.starter;

import org.junit.jupiter.api.Test;

import java.io.IOException;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.junit.jupiter.api.Assumptions.assumeTrue;

/**
 * The starter bundles pin their Maven coordinates on
 * {@link StarterBundles#VERSION}, and {@code /api/bundles} serves the same
 * constant to the About dialog. The release pipeline (tag.yml, playbook step 2)
 * bumps versions in the Gradle files and package.json — a Java literal is
 * invisible to it, which is exactly how {@code 0.4.1} stood still through the
 * 0.5.0 cut (card 143): the line resolved on Central, so it worked and was
 * wrong.
 *
 * <p>The constant is therefore stamped by the build — {@code processResources}
 * expands the module version into {@code starter/spectro-version.properties}
 * and StarterBundles reads it at class-init, failing loudly if the stamp is
 * missing. This test holds the whole chain to the build files on disk, the
 * same shape as {@code HeapFlagDriftTest}: when a number crosses from Gradle
 * into Java with no import between them, the test has to go and look.
 */
class StarterVersionDriftTest {

    private static final Pattern GRADLE_VERSION =
            Pattern.compile("(?m)^version\\s*=\\s*\"([^\"]+)\"");

    @Test
    void servedVersionIsTheBuildVersion() throws IOException {
        Path root = repoRoot();
        assumeTrue(root != null, "not running from a source checkout");
        String built = gradleVersion(root, "spectro-server/build.gradle.kts");
        assertEquals(built, StarterBundles.VERSION,
                "spectro-server builds as " + built + " but the starter bundles (and /api/bundles,"
                        + " which the About dialog trusts) would say " + StarterBundles.VERSION
                        + " — the version must travel with the build, never by hand");
    }

    @Test
    void theStampedVersionNamesWhatCoreActuallyPublishes() throws IOException {
        // The coordinates the bundles render are spectro-core's and
        // spectro-orchestrator's; the stamp is the server module's own version.
        // tag.yml moves every build file together — hold that lockstep, or the
        // stamp could name a version core never publishes.
        Path root = repoRoot();
        assumeTrue(root != null, "not running from a source checkout");
        String server = gradleVersion(root, "spectro-server/build.gradle.kts");
        assertEquals(gradleVersion(root, "spectro-core/build.gradle.kts"), server,
                "spectro-core and spectro-server carry different versions — the bundle"
                        + " coordinates would pin a spectro-core that was never cut");
        assertEquals(gradleVersion(root, "spectro-orchestrator/build.gradle.kts"), server,
                "spectro-orchestrator and spectro-server carry different versions — the fleet"
                        + " bundles would pin an orchestrator that was never cut");
    }

    @Test
    void theStampedResourceExistsAndIsExpanded() throws IOException {
        try (InputStream in = StarterBundles.class
                .getResourceAsStream("/starter/spectro-version.properties")) {
            assertNotNull(in, "starter/spectro-version.properties is missing from the classpath"
                    + " — processResources no longer stamps the module version");
            String text = new String(in.readAllBytes(), StandardCharsets.UTF_8);
            assertTrue(text.contains("version="), text);
            assertFalse(text.contains("${"),
                    "the version placeholder was not expanded — processResources lost its"
                            + " expand() for this file:\n" + text);
        }
    }

    private static String gradleVersion(Path root, String relative) throws IOException {
        Path file = root.resolve(relative);
        assertTrue(Files.isRegularFile(file), "build file vanished: " + relative);
        Matcher matcher = GRADLE_VERSION.matcher(Files.readString(file));
        assertTrue(matcher.find(), "no version = \"…\" line in " + relative);
        return matcher.group(1);
    }

    /**
     * Walks up from the module directory to the directory holding
     * {@code settings.gradle.kts}.
     *
     * @return the checkout root, or null when this runs outside one
     */
    private static Path repoRoot() {
        Path here = Path.of("").toAbsolutePath();
        for (Path candidate = here; candidate != null; candidate = candidate.getParent()) {
            if (Files.isRegularFile(candidate.resolve("settings.gradle.kts"))) {
                return candidate;
            }
        }
        return null;
    }
}
