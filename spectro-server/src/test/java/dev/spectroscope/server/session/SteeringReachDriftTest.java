package dev.spectroscope.server.session;

import org.junit.jupiter.api.Test;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.regex.Pattern;
import java.util.stream.Stream;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.junit.jupiter.api.Assumptions.assumeTrue;

/**
 * Card 380, criterion 14: a headless run is untouched.
 *
 * <p>What makes it untouched is one fact and not a promise: the loop reads an
 * inbox only when one was wired, and exactly one face wires one. A spectro run,
 * a cron fire, a fleet node and a child agent all build their agents without
 * it, so their streams gain no event and lose no ordering.</p>
 *
 * <p>The list of wiring sites is DERIVED from the tree rather than typed out
 * here. A hand list guarded by a test that types the same hand list is two
 * copies of one claim: the next face to wire an inbox would be added to both
 * and nothing would ever go red. This walks every main source file under the
 * checkout and counts the call sites it finds.</p>
 *
 * <p><b>What this does not claim.</b> It is not the byte-identical stream
 * comparison the card asked for. It says no headless face can reach the
 * feature. The byte comparison is {@code HeadlessStreamBaselineTest} in
 * spectro-cli, against streams recorded on a {@code git archive} of
 * {@code main} at {@code 301f6e69}.</p>
 */
class SteeringReachDriftTest {

    /** A builder call that HANDS an inbox over, never the record accessor that
     *  reads one back: {@code options.steering()} has empty parentheses and
     *  {@code .steering(steering)} does not. Matching the bare method name put
     *  Agent.java on the list, which reads the field and wires nothing. */
    private static final Pattern WIRES_ONE = Pattern.compile("\\.steering\\([^)]");

    /** The one face with a person attached while a turn is in flight. */
    private static final String THE_ONE_FACE =
            "spectro-server/src/main/java/dev/spectroscope/server/session/SessionConnection.java";

    @Test
    void exactlyOneFaceWiresAnInboxIntoAnAgent() throws IOException {
        Path root = repoRoot();
        assumeTrue(root != null, "not running from a source checkout");

        List<String> wiring = new ArrayList<>();
        for (Path file : mainSources(root)) {
            String body = Files.readString(file, StandardCharsets.UTF_8);
            if (WIRES_ONE.matcher(body).find()) {
                wiring.add(root.relativize(file).toString().replace('\\', '/'));
            }
        }
        assertTrue(mainSources(root).size() > 100,
                "the walk found almost no sources, so the count below measures nothing: "
                        + mainSources(root).size());

        assertEquals(List.of(THE_ONE_FACE), wiring,
                "a second face wiring a steering inbox changes what a headless run records; "
                        + "found: " + wiring);
    }

    @Test
    void theBuilderMethodTheCountLooksForStillExists() throws IOException {
        // The positive twin. Without it the count above is green on a tree where
        // the builder was renamed and nothing wires anything at all, which is
        // the failure mode a pure count cannot see.
        Path root = repoRoot();
        assumeTrue(root != null, "not running from a source checkout");

        String options = Files.readString(
                root.resolve("spectro-core/src/main/java/dev/spectroscope/core/AgentOptions.java"),
                StandardCharsets.UTF_8);

        assertTrue(options.contains("public Builder steering("),
                "the builder call the reach count searches for is gone, so the count means nothing");
    }

    private static List<Path> mainSources(Path root) throws IOException {
        List<Path> files = new ArrayList<>();
        try (Stream<Path> walk = Files.walk(root)) {
            // Matched on the path RELATIVE to the checkout. An absolute path
            // carries whatever the checkout happens to sit in, and this one
            // sits under a folder called worktrees, which an absolute match
            // silently excluded: the walk returned nothing and the count was
            // green on an empty list.
            walk.filter(Files::isRegularFile)
                    .filter(p -> {
                        String rel = root.relativize(p).toString().replace('\\', '/');
                        return rel.endsWith(".java")
                                && rel.contains("/src/main/java/")
                                && !rel.contains("/build/");
                    })
                    .forEach(files::add);
        }
        return files;
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
