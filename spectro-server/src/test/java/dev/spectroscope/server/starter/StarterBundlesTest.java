package dev.spectroscope.server.starter;

import dev.spectroscope.server.starter.StarterBundles.BuildTool;
import org.junit.jupiter.api.Test;

import java.util.Map;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

/** The embedded starter bundles: pure, deterministic content with the real
 *  published Maven coordinates and the right build files per tool. */
class StarterBundlesTest {

    @Test
    void shipsThreeBundlesWithStableIds() {
        assertEquals(
                java.util.List.of("five-lines", "fleet", "multi-agent"),
                StarterBundles.list().stream().map(StarterBundles.Bundle::id).toList());
    }

    @Test
    void buildToolParseIsLenientAndDefaultsToGradle() {
        assertEquals(BuildTool.MAVEN, BuildTool.of("maven"));
        assertEquals(BuildTool.MAVEN, BuildTool.of("MVN"));
        assertEquals(BuildTool.GRADLE, BuildTool.of("gradle"));
        assertEquals(BuildTool.GRADLE, BuildTool.of(null));
        assertEquals(BuildTool.GRADLE, BuildTool.of("nonsense"));
    }

    @Test
    void unknownBundleRendersNull() {
        assertNull(StarterBundles.files("nope", BuildTool.GRADLE));
        assertNull(StarterBundles.byId("nope"));
    }

    @Test
    void gradleBundleHasSettingsBuildAndSourceWithRealCoordinates() {
        Map<String, String> files = StarterBundles.files("five-lines", BuildTool.GRADLE);
        assertNotNull(files);
        assertTrue(files.containsKey("settings.gradle.kts"));
        assertTrue(files.containsKey("build.gradle.kts"));
        assertTrue(files.containsKey("src/main/java/demo/FiveLines.java"));
        String build = files.get("build.gradle.kts");
        assertTrue(build.contains("dev.spectroscope:spectro-core:" + StarterBundles.VERSION), build);
        assertTrue(build.contains("mavenCentral()"));
        assertTrue(build.contains("mainClass.set(\"demo.FiveLines\")"));
        // a single-agent bundle does NOT pull the orchestrator
        assertFalse(build.contains("spectro-orchestrator"), build);
        assertTrue(files.get("src/main/java/demo/FiveLines.java").contains("Spectro.agent()"));
    }

    @Test
    void mavenBundleHasPomWithRealCoordinates() {
        Map<String, String> files = StarterBundles.files("five-lines", BuildTool.MAVEN);
        assertNotNull(files);
        assertTrue(files.containsKey("pom.xml"));
        String pom = files.get("pom.xml");
        assertTrue(pom.contains("<groupId>dev.spectroscope</groupId>"), pom);
        assertTrue(pom.contains("<artifactId>spectro-core</artifactId>"));
        assertTrue(pom.contains("<version>" + StarterBundles.VERSION + "</version>"));
        assertTrue(pom.contains("<mainClass>demo.FiveLines</mainClass>"));
    }

    @Test
    void fleetBundlesAlsoPullTheOrchestrator() {
        for (String id : java.util.List.of("fleet", "multi-agent")) {
            String gradle = StarterBundles.files(id, BuildTool.GRADLE).get("build.gradle.kts");
            assertTrue(gradle.contains("spectro-orchestrator:" + StarterBundles.VERSION), id + " gradle: " + gradle);
            String pom = StarterBundles.files(id, BuildTool.MAVEN).get("pom.xml");
            assertTrue(pom.contains("<artifactId>spectro-orchestrator</artifactId>"), id + " pom");
        }
        assertTrue(StarterBundles.byId("fleet").source().contains("Spectro.panel()"));
    }
}
