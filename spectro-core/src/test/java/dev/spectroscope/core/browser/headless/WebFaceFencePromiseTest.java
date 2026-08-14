package dev.spectroscope.core.browser.headless;

import org.junit.jupiter.api.Test;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;

import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.junit.jupiter.api.Assumptions.assumeTrue;

/**
 * The web face's fence PROMISE, pinned against the docs (card 226,
 * criterion 3) — {@code browse_page}'s precedent applied.
 *
 * <p>The headless engine judges every DOCUMENT request and honestly does not
 * judge subresources; the live drive measures both halves. What a measurement
 * cannot do is keep a sentence true in a file it does not read, so this test
 * holds the promise's key words in {@code docs/BROWSER.md} and in
 * {@link HeadlessBrowserFace#SUBRESOURCE_PROMISE} to the same wording. If the
 * engine ever starts judging subresources (or stops judging documents), the
 * live drive goes red and this file names every place the new truth must be
 * written before the sentence can change.
 */
class WebFaceFencePromiseTest {

    /** The load-bearing words: what is judged, and what deliberately is not. */
    private static final String JUDGED =
            "every DOCUMENT request";
    private static final String NOT_JUDGED =
            "Subresources (scripts, images, XHR) are not judged on this face";

    @Test
    void thePromiseConstantSaysWhatIsJudgedAndWhatIsNot() {
        assertTrue(HeadlessBrowserFace.SUBRESOURCE_PROMISE.contains(JUDGED),
                "the promise must state its positive half");
        assertTrue(HeadlessBrowserFace.SUBRESOURCE_PROMISE.contains(NOT_JUDGED),
                "the promise must state its limit in so many words");
    }

    @Test
    void theDocsCarryTheSamePromiseWordForWord() throws IOException {
        Path doc = source("docs/BROWSER.md");
        assumeTrue(doc != null, "not running from a source checkout");
        // The doc wraps at 80 columns; the words are compared, not the wrapping.
        String text = Files.readString(doc).replaceAll("\\s+", " ");
        assertTrue(text.contains(NOT_JUDGED),
                "docs/BROWSER.md must promise the web face's fence limit in the same "
                        + "words the code does — never claim what the engine cannot police");
        assertTrue(text.contains("Mach auf dem Browser einen nativen Inlay-Browser"),
                "the owner's reversal is the reason this face exists and the docs "
                        + "quote it (card 226, criterion 6)");
        assertTrue(text.contains("/ws/browser-view"),
                "the picture channel's wire lives in the docs the UI half reads");
    }

    private static Path source(String relative) {
        for (Path candidate = Path.of("").toAbsolutePath();
                candidate != null; candidate = candidate.getParent()) {
            if (Files.isRegularFile(candidate.resolve("settings.gradle.kts"))) {
                Path file = candidate.resolve(relative);
                return Files.isRegularFile(file) ? file : null;
            }
        }
        return null;
    }
}
