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
