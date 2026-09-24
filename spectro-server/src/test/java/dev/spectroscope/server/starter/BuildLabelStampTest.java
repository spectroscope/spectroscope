package dev.spectroscope.server.starter;

import org.junit.jupiter.api.Test;

import java.io.ByteArrayInputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;
import java.util.Map;
import java.util.Properties;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.junit.jupiter.api.Assumptions.assumeTrue;

/**
 * Card 398: the build label travels from the Gradle property
 * {@code spectro.buildLabel} into {@code /starter/spectro-version.properties},
 * from there into {@link StarterBundles#BUILD_LABEL}, and out of
 * {@code /api/bundles} next to the plain version.
 */
class BuildLabelStampTest {

    private static final String LABEL = "0.13.0-beta (merge-2026-09-24, a1b2c3d, 24.09. 14:05)";

    private static StarterBundles.Stamp stamp(String text) throws IOException {
        return StarterBundles.Stamp.read(
                new ByteArrayInputStream(text.getBytes(StandardCharsets.UTF_8)), "test.properties");
    }

    @Test
    void aTestBuildStampCarriesTheLabelBesideThePlainVersion() throws IOException {
        StarterBundles.Stamp s = stamp("# stamped\nversion=0.12.0\nlabel=" + LABEL + "\n");
        assertEquals("0.12.0", s.version());
        assertEquals(LABEL, s.label());
    }

    @Test
    void aReleaseStampCarriesNoLabel() throws IOException {
        // The shape processResources writes without the property: the label
        // line expands to an empty line.
        StarterBundles.Stamp s = stamp("# stamped\nversion=0.12.0\n\n");
        assertEquals("0.12.0", s.version());
        assertNull(s.label());
    }

    @Test
    void aBlankLabelIsNoLabel() throws IOException {
        assertNull(stamp("version=0.12.0\nlabel=   \n").label());
        assertNull(stamp("version=0.12.0\nlabel=\n").label());
    }

    @Test
    void aBranchNameOutsideAsciiSurvivesTheStamp() throws IOException {
        // processResources writes the file as UTF-8, so it is read as UTF-8.
        String label = "0.13.0-beta (karte-398-überblick, a1b2c3d, 24.09. 14:05)";
        assertEquals(label, stamp("version=0.12.0\nlabel=" + label + "\n").label());
    }

    @Test
    void anUnexpandedVersionIsStillRefused() {
        IllegalStateException e = assertThrows(IllegalStateException.class,
                () -> stamp("version=${version}\n${labelLine}\n"));
        assertTrue(e.getMessage().contains("unstamped"), e.getMessage());
    }

    @Test
    void theCatalogNamesTheLabelNextToThePlainVersionOnATestBuild() {
        Map<String, Object> catalog = BundleController.catalog("0.12.0", LABEL);
        assertEquals("0.12.0", catalog.get("version"), "the version the coordinates pin stays plain");
        assertEquals(LABEL, catalog.get("label"));
        assertEquals(List.of("gradle", "maven", "python", "bash"), catalog.get("buildTools"));
    }

    @Test
    void theCatalogOfAReleaseBuildHasNoLabelKey() {
        Map<String, Object> catalog = BundleController.catalog("0.12.0", null);
        assertEquals("0.12.0", catalog.get("version"));
        assertFalse(catalog.containsKey("label"), "a release answers exactly what it answered before");
    }

    @Test
    void theEndpointServesWhatThisBuildStamped() {
        Map<String, Object> served = new BundleController().list();
        assertEquals(StarterBundles.VERSION, served.get("version"));
        assertEquals(StarterBundles.BUILD_LABEL, served.get("label"));
        assertEquals(StarterBundles.BUILD_LABEL != null, served.containsKey("label"));
    }

    /**
     * The stamp on the test classpath is the processResources OUTPUT, not the
     * source file. Gradle hands the test JVM the label this build was given
     * ({@code -Pspectro.buildLabel}, empty without it), so the check holds in
     * both directions: run the gate with a label and the output must carry it.
     */
    @Test
    void theBuiltStampCarriesTheLabelThisBuildWasGiven() throws IOException {
        String expected = System.getProperty("spectro.test.expectedBuildLabel");
        assumeTrue(expected != null, "run through Gradle, which passes the build's label to the test JVM");

        Properties built = new Properties();
        try (InputStream in = StarterBundles.class.getResourceAsStream("/starter/spectro-version.properties")) {
            assertNotNull(in, "the stamp is missing from the classpath");
            built.load(new InputStreamReader(in, StandardCharsets.UTF_8));
        }
        assertEquals(gradleVersion(), built.getProperty("version"), "the plain version is always stamped");
        assertEquals(gradleVersion(), StarterBundles.VERSION);
        if (expected.isBlank()) {
            assertNull(built.getProperty("label"), "a build without a label stamps none");
            assertNull(StarterBundles.BUILD_LABEL);
        } else {
            assertEquals(expected.strip(), built.getProperty("label"));
            assertEquals(expected.strip(), StarterBundles.BUILD_LABEL);
        }
    }

    private static String gradleVersion() throws IOException {
        Path file = ScriptTree.repoRoot().resolve("spectro-server/build.gradle.kts");
        Matcher m = Pattern.compile("(?m)^version\\s*=\\s*\"([^\"]+)\"").matcher(Files.readString(file));
        assertTrue(m.find(), "no version line in " + file);
        return m.group(1);
    }
}
