package dev.spectroscope.core.scheduler;

import org.junit.jupiter.api.Test;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;

import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.junit.jupiter.api.Assumptions.assumeTrue;

/**
 * The guide's headless chapter against what a headless run can now reach.
 *
 * <p>Card 220's review, the one blocker: the change taught chapter 3 and
 * chapter 30 that a headless run mounts the configured MCP servers on consent,
 * and chapter 27's "The headless variant" went on saying "standard tools only
 * (never the spawn tools)" — unconditional, made false by this very change. One
 * document disagreed with itself about what an unattended run can reach, which
 * is this card's own defect class: an assertion fixed in one place and left
 * standing in the next.
 *
 * <p>Same shape as {@code McpGuideDriftTest}: the sentence and the code live in
 * files that cannot import each other, so the only way to keep them together is
 * a test that goes and looks. Assertions run against whitespace-collapsed text,
 * because the source is hand-wrapped.
 */
class HeadlessGuideDriftTest {

    private static final Path CHAPTER = Path.of("docs/guide-assets/parts/17-ref-loop.html");

    @Test
    void theHeadlessVariantSectionTellsTheTruthAboutMcpReach() throws IOException {
        String section = headlessVariantSection();
        assumeTrue(section != null, "not running from a source checkout");

        assertFalse(section.contains("standard tools only"),
                "chapter 27 is back to the unconditional claim: a headless run carries"
                        + " standard tools only. False since card 220 — the configured MCP"
                        + " servers mount when the headlessMcp setting or spectro run --mcp"
                        + " asks for them. Section: " + section);
        assertTrue(section.contains("headlessMcp"),
                "chapter 27 describes what a headless run reaches without naming the"
                        + " headlessMcp switch that widens it — the reader deciding whether"
                        + " to leave a cron job unattended consults exactly this section."
                        + " Section: " + section);
        assertTrue(section.contains("--mcp"),
                "chapter 27 no longer names the per-invocation override (spectro run"
                        + " --mcp), so the setting reads as the only road. Section: "
                        + section);
        assertTrue(section.contains("chapter 30"),
                "chapter 27 states the MCP condition without pointing at chapter 30,"
                        + " where the switch's scope rules and auto-approval warning live."
                        + " Section: " + section);
        assertTrue(section.contains("never the spawn tools"),
                "chapter 27 lost the half of the old sentence that stays true: the spawn"
                        + " tools are never mounted headless, consent or not. Section: "
                        + section);
    }

    /**
     * The "The headless variant" section of chapter 27 — from its heading to the
     * chapter-28 heading — whitespace-collapsed, read from the part the guide
     * generator assembles.
     *
     * @return the section text, or {@code null} when not run from a checkout
     */
    private static String headlessVariantSection() throws IOException {
        Path root = repoRoot();
        if (root == null || !Files.isRegularFile(root.resolve(CHAPTER))) {
            return null;
        }
        String part = Files.readString(root.resolve(CHAPTER));
        int start = part.indexOf("id=\"ch-loop-headless\"");
        if (start < 0) {
            throw new AssertionError("\"The headless variant\" is gone from " + CHAPTER);
        }
        int end = part.indexOf("data-ch=\"28\"", start);
        String section = end > start ? part.substring(start, end) : part.substring(start);
        return section.replaceAll("\\s+", " ");
    }

    /** Walks up to the directory holding the Gradle settings file. */
    private static Path repoRoot() {
        for (Path candidate = Path.of("").toAbsolutePath();
                candidate != null; candidate = candidate.getParent()) {
            if (Files.isRegularFile(candidate.resolve("settings.gradle.kts"))) {
                return candidate;
            }
        }
        return null;
    }
}
