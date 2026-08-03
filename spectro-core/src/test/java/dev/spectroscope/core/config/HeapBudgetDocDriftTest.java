package dev.spectroscope.core.config;

import org.junit.jupiter.api.Test;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;

import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assumptions.assumeTrue;

/**
 * The class javadoc against the class.
 *
 * <p>Ordinarily a comment is not worth a test. This one is, because
 * {@code HeapFlagDriftTest} deliberately sends the next person who raises
 * {@code MAX_CONTENT_BYTES} through both constants in this file, and the first
 * thing they read at the top of it told them the floor would rise with the cap.
 * It does not: {@code floorBytes()} returns a constant, three other places in
 * the same file say so, and a test asserts it. A comment that prescribes the
 * wrong action to the exact reader another test summons is a defect, not a nit.
 */
class HeapBudgetDocDriftTest {

    /**
     * Sentences the premise-replacing commit left standing, each of them false
     * about the shipped code.
     */
    private static final List<String> REPLACED_PREMISE = List.of(
            "Raise the cap and this floor rises with it",
            "the cap is the heap budget",
            "the read holds the whole file as a UTF-16 String",
            "times the expansion");

    /**
     * Present-tense claims that the floor derives from the cap. Past-tense
     * history is deliberately legal: the file explains at length what the floor
     * used to be and why it stopped being that, and that account is the reason
     * the next reader believes the correction.
     */
    private static final List<String> DERIVATION_CLAIMS = List.of(
            "the floor is a function of",
            "the floor follows the cap",
            "the floor is derived from the cap");

    @Test
    void theClassJavadocDoesNotTeachAFloorThatFollowsTheCap() throws IOException {
        Path source = repoRoot() == null ? null
                : repoRoot().resolve("spectro-core/src/main/java/dev/spectroscope/core/config/HeapBudget.java");
        assumeTrue(source != null && Files.isRegularFile(source), "not running from a source checkout");

        String header = classJavadoc(Files.readString(source));
        for (String dead : REPLACED_PREMISE) {
            assertFalse(header.contains(dead),
                    "the class javadoc still teaches the premise the streamed read deleted: \"" + dead
                            + "\". floorBytes() returns a constant, and HeapBudgetTest"
                            + ".theFloorDoesNotFollowTheImportCapBecauseTheReadIsStreamed pins it.");
        }
    }

    /**
     * The header was not the only comment that outlived the premise, and the
     * sibling test above could not have caught the other one: it reads only the
     * text above the record declaration, while {@code TRANSCRIPT_IMPORT_CAP_BYTES}
     * sits inside the body.
     *
     * <p>This one reads every javadoc in the file with its line wrapping removed,
     * which is the point. The surviving sentence broke across two lines as
     * "and the floor" / "is a function of it", so it was invisible to every
     * line-oriented grep for the phrase, and it outlived three separate reviews
     * of this exact file for that reason. Unwrap first, then look.
     */
    @Test
    void noJavadocInTheFileStillDerivesTheFloorFromTheCap() throws IOException {
        Path source = repoRoot() == null ? null
                : repoRoot().resolve("spectro-core/src/main/java/dev/spectroscope/core/config/HeapBudget.java");
        assumeTrue(source != null && Files.isRegularFile(source), "not running from a source checkout");

        String unwrapped = unwrappedJavadoc(Files.readString(source));
        for (String claim : DERIVATION_CLAIMS) {
            assertFalse(unwrapped.contains(claim),
                    "a javadoc in HeapBudget still says \"" + claim + "\" the cap. floorBytes() returns "
                            + "FLOOR_BYTES regardless of importCapBytes, the record's own @param calls the "
                            + "cap \"not a heap input\", and HeapBudgetTest"
                            + ".theFloorDoesNotFollowTheImportCapBecauseTheReadIsStreamed measures it. "
                            + "Whoever raises the cap must not be told to move the floor with it.");
        }
    }

    /**
     * Every javadoc block in the file, stripped of its {@code *} margins and
     * collapsed onto one line each, so a sentence split by wrapping reads as the
     * sentence it is.
     */
    private static String unwrappedJavadoc(String source) {
        StringBuilder all = new StringBuilder();
        java.util.regex.Matcher blocks =
                java.util.regex.Pattern.compile("/\\*\\*.*?\\*/", java.util.regex.Pattern.DOTALL)
                        .matcher(source);
        while (blocks.find()) {
            all.append(blocks.group().replaceAll("(?m)^\\s*\\*+/?", " ").replaceAll("\\s+", " "))
                    .append('\n');
        }
        return all.toString();
    }

    /** Everything above the record declaration, i.e. the header the reader meets first. */
    private static String classJavadoc(String source) {
        int declaration = source.indexOf("public record HeapBudget");
        return declaration < 0 ? source : source.substring(0, declaration);
    }

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
