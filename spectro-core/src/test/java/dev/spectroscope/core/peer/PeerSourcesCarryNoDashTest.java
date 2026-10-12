package dev.spectroscope.core.peer;

import org.junit.jupiter.api.Test;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.stream.Stream;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * House rule for card 502: no em dash and no en dash in the peer package, in
 * code, comments or test names. The files are read from the source tree, so a
 * new file is checked without a list to update.
 */
class PeerSourcesCarryNoDashTest {

    private static final char EM_DASH = (char) 0x2014;
    private static final char EN_DASH = (char) 0x2013;

    private static final List<Path> ROOTS = List.of(
            Path.of("src/main/java/dev/spectroscope/core/peer"),
            Path.of("src/test/java/dev/spectroscope/core/peer"));

    static List<String> dashLines(Path root) throws IOException {
        List<String> hits = new ArrayList<>();
        try (Stream<Path> files = Files.walk(root)) {
            for (Path file : files.filter(f -> f.toString().endsWith(".java")).sorted().toList()) {
                List<String> lines = Files.readAllLines(file);
                for (int i = 0; i < lines.size(); i++) {
                    if (lines.get(i).indexOf(EM_DASH) >= 0 || lines.get(i).indexOf(EN_DASH) >= 0) {
                        hits.add(file + ":" + (i + 1));
                    }
                }
            }
        }
        return hits;
    }

    @Test
    void thePeerPackageCarriesNoDash() throws IOException {
        List<String> hits = new ArrayList<>();
        for (Path root : ROOTS) {
            hits.addAll(dashLines(root));
        }
        assertEquals(List.of(), hits);
    }

    @Test
    void theWalkReadsThePackage() throws IOException {
        long files;
        try (Stream<Path> walk = Files.walk(ROOTS.getFirst())) {
            files = walk.filter(f -> f.toString().endsWith("PeerEndpoint.java")).count();
        }
        assertEquals(1, files, "the walk starts in the module directory");
    }

    @Test
    void theScanFindsADash(@org.junit.jupiter.api.io.TempDir Path dir) throws IOException {
        Files.writeString(dir.resolve("Sample.java"), "class Sample {\n    // one " + EM_DASH + " two\n}\n");
        assertTrue(dashLines(dir).getFirst().endsWith("Sample.java:2"));
    }
}
