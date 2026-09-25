package dev.spectroscope.server.session;

import org.junit.jupiter.api.Test;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import java.util.stream.Stream;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.junit.jupiter.api.Assumptions.assumeTrue;

/**
 * Card 427, criterion 5: the places that build the ask, read off the tree.
 *
 * <p>Card 427 lets a question park in {@code auto} and {@code readonly} on the
 * browser face. That is safe only while every face that builds the tool has a
 * person who can answer it, or an asker that never parks. This walks every main
 * source file of the checkout and lists each construction of
 * {@code AskUserQuestionTool}, so a fourth one, a headless one included, turns
 * this red instead of passing unnoticed.</p>
 *
 * <p>The card named two sites. The tree has three: the interactive REPL in
 * {@code SpectroCli} builds one too, with the terminal asker, and only when a
 * terminal asker is set.</p>
 */
class AskReachDriftTest {

    private static final Pattern BUILDS_THE_ASK = Pattern.compile(
            "new\\s+(?:dev\\.spectroscope\\.core\\.tools\\.)?AskUserQuestionTool\\s*\\(");

    /** The REPL, with the terminal asker; the describe endpoint, with Asker.none();
     *  the browser session, with its ParkingAsker. */
    private static final List<String> THE_THREE_SITES = List.of(
            "spectro-cli/src/main/java/dev/spectroscope/cli/SpectroCli.java",
            "spectro-server/src/main/java/dev/spectroscope/server/session/ContextDescriber.java",
            "spectro-server/src/main/java/dev/spectroscope/server/session/SessionConnection.java");

    @Test
    void exactlyThreeProductionSitesBuildTheAsk() throws IOException {
        Path root = repoRoot();
        assumeTrue(root != null, "not running from a source checkout");
        List<Path> sources = mainSources(root);
        assertTrue(sources.size() > 100,
                "the walk found almost no sources, so the list below measures nothing: "
                        + sources.size());

        List<String> sites = new ArrayList<>();
        for (Path file : sources) {
            Matcher matcher = BUILDS_THE_ASK.matcher(Files.readString(file, StandardCharsets.UTF_8));
            while (matcher.find()) {
                sites.add(root.relativize(file).toString().replace('\\', '/'));
            }
        }
        sites.sort(null);

        assertEquals(THE_THREE_SITES, sites,
                "a new place builds ask_user_question; a face with nobody to answer must not"
                        + " carry it, see card 427: " + sites);
    }

    @Test
    void theDescribeEndpointBuildsItWithTheAskerThatNeverParks() throws IOException {
        Path root = repoRoot();
        assumeTrue(root != null, "not running from a source checkout");
        String body = Files.readString(root.resolve(THE_THREE_SITES.get(1)), StandardCharsets.UTF_8);
        Matcher matcher = BUILDS_THE_ASK.matcher(body);
        assertTrue(matcher.find(), "ContextDescriber no longer builds the ask at all");
        String call = body.substring(matcher.end(), Math.min(body.length(), matcher.end() + 40));
        assertTrue(call.startsWith("Asker.none()"),
                "the describe endpoint never drives a run, so its ask must never park: " + call);
    }

    private static List<Path> mainSources(Path root) throws IOException {
        List<Path> files = new ArrayList<>();
        try (Stream<Path> walk = Files.walk(root)) {
            walk.filter(Files::isRegularFile)
                    .filter(p -> {
                        String rel = root.relativize(p).toString().replace('\\', '/');
                        return rel.endsWith(".java")
                                && rel.contains("/src/main/java/")
                                && !rel.contains("/build/")
                                && !rel.contains("node_modules/");
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
