package dev.spectroscope.core.launch;

import org.junit.jupiter.api.Test;

import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.junit.jupiter.api.Assumptions.assumeTrue;

/**
 * Card 202 criterion 6: the compatibility goal closes the card, and it is
 * tested against REAL files rather than an idealized one.
 *
 * <p>Two halves, and both are needed for different reasons.
 *
 * <p><b>The fixture half always runs</b>, including in CI where the operator's
 * home does not exist. It carries the three shapes the format allows and this
 * reader has to survive: a top-level {@code version}, the {@code autoPort} key
 * the reader does not use, and the {@code url}-with-no-command entry that no
 * file on this machine carried when the corpus was measured (0 of 58 entries on
 * 2026-08-13). The card asks for exactly that fixture, in the same JSON Claude
 * Code accepts, shipped beside the test.
 *
 * <p><b>The real-file half runs where the files are</b> and is skipped where
 * they are not, because a test that hard-fails on a machine without the
 * operator's home would be a test about the machine. It loads the two files the
 * card names, unedited, and asserts every name in them is offered. When it
 * skips, the fixture half still holds the format claims — what it cannot hold is
 * the claim that a real file loads, and that is the honest split rather than a
 * green that means nothing.
 */
class LaunchFormatCorpusTest {

    /** The two real files criterion 6 names, relative to the operator's home. */
    private static final List<String> REAL_FILES = List.of(
            "Spectroscope/.claude/launch.json",
            "Spectroscope/spectroscope-edu-suite/spectroscope-edu/.claude/launch.json");

    /**
     * The url-only attach shape, from the fixture that ships beside this test.
     * Criterion 6 asks for it because no local file carries the shape.
     */
    @Test
    void theShippedFixtureCarriesTheShapeNoLocalFileHas() throws Exception {
        LaunchFile file = LaunchFile.parse(fixture());
        assertEquals("0.0.1", file.version());
        assertEquals(List.of("web", "api-already-running", "docs"), file.names());
        assertEquals(0, file.skipped());

        LaunchEntry attach = file.find("api-already-running").orElseThrow();
        assertTrue(attach.attaches(), "a url with no command is attached, never spawned");
        assertEquals("http://localhost:4321/health", attach.address());

        LaunchEntry autoPort = file.find("docs").orElseThrow();
        assertEquals(List.of("autoPort"), autoPort.unknownKeys(),
                "the one key the measured corpus carries and this reader does not use");
        assertEquals("http://localhost:8000/", autoPort.address());
    }

    /**
     * The real files, unedited. Skipped where they are not, and the skip says so.
     */
    @Test
    void theOperatorsOwnFilesLoadUneditedAndOfferEveryName() throws Exception {
        Path home = realHome();
        int checked = 0;
        for (String relative : REAL_FILES) {
            Path path = home.resolve(relative);
            if (!Files.isRegularFile(path)) {
                continue;
            }
            checked++;
            String text = Files.readString(path, StandardCharsets.UTF_8);
            LaunchFile file = LaunchFile.parse(text);
            assertFalse(file.names().isEmpty(), relative + " offers at least one name");
            assertEquals(0, file.skipped(), relative + " loses no entry to the reader");
            assertEquals(countEntries(text), file.names().size(),
                    relative + " offers every entry the file carries");
            for (LaunchEntry entry : file.entries()) {
                assertNotNull(entry.name());
                assertNotNull(entry.address(), relative + ": " + entry.name()
                        + " has an address to open");
            }
        }
        assumeTrue(checked > 0,
                "neither real launch.json is on this machine — the fixture half still ran");
    }

    /**
     * The real home, which is NOT {@code user.home} here.
     *
     * <p>This module's test task points {@code user.home} at
     * {@code build/test-home} on purpose, so that {@code ~/.spectro} resolution
     * stays off the real home. Reading the property would therefore have made
     * this test skip on the one machine the files are on — silently, and with a
     * green suite to show for it. That is exactly the shape of green the house
     * rule warns about, and it happened on the first run of this test. The
     * environment variable is not redirected, so it is what "the operator's own
     * home" actually means here.
     *
     * @return the home directory of whoever is running the suite
     */
    private static Path realHome() {
        String fromEnv = System.getenv("HOME");
        return Path.of(fromEnv == null || fromEnv.isBlank()
                ? System.getProperty("user.home") : fromEnv);
    }

    /** Counts the entries by text, so the assertion above is not the reader checking itself. */
    private static int countEntries(String json) {
        int count = 0;
        int at = 0;
        while ((at = json.indexOf("\"name\"", at)) >= 0) {
            count++;
            at += 6;
        }
        return count;
    }

    private static String fixture() throws Exception {
        try (InputStream in = LaunchFormatCorpusTest.class
                .getResourceAsStream("/launch/fixture-launch.json")) {
            assertNotNull(in, "the fixture ships beside the test");
            return new String(in.readAllBytes(), StandardCharsets.UTF_8);
        }
    }
}
