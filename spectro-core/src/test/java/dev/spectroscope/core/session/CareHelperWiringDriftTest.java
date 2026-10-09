package dev.spectroscope.core.session;

import org.junit.jupiter.api.Test;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.Optional;
import java.util.regex.Pattern;
import java.util.stream.Stream;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.junit.jupiter.api.Assumptions.assumeTrue;

/**
 * Card 492, criterion 2: the helper count the care paragraph names has one
 * source, {@code CareParagraph.helpersFor(SpectroConfig)}, and every face that
 * can offer a spawn tool takes it from there.
 *
 * <p>Card 490 brings the session count per chat as the key
 * {@code sessionsPerChat}. It is on no branch this card builds on, so
 * {@code helpersFor} returns {@link CareParagraph#DEFAULT_HELPERS} today. The
 * tripwire below turns red in any tree where {@code SpectroConfig} declares
 * that key and {@code CareParagraph} does not read it, so the integration of
 * the two cards cannot leave the paragraph naming a fixed two.</p>
 */
class CareHelperWiringDriftTest {

    private static final Pattern SESSION_COUNT_COMPONENT =
            Pattern.compile("\\b(?:Integer|int)\\s+sessionsPerChat\\b");
    private static final Pattern CARE_CALL =
            Pattern.compile("(?:\\bcareParagraph|\\bsetCareParagraph|CareParagraph\\.suffix)\\(");
    private static final String DERIVATION = "CareParagraph.helpersFor(";

    /**
     * What is missing when the config declares a session count per chat and
     * the paragraph does not read it.
     *
     * @param configSource the text of {@code SpectroConfig.java}
     * @param careSource   the text of {@code CareParagraph.java}
     * @return the complaint, or empty when nothing is missing
     */
    static Optional<String> missingSessionCountWiring(String configSource, String careSource) {
        if (!SESSION_COUNT_COMPONENT.matcher(configSource).find()) {
            return Optional.empty();
        }
        if (careSource.contains("sessionsPerChat()")) {
            return Optional.empty();
        }
        return Optional.of("SpectroConfig declares sessionsPerChat (card 490), and"
                + " CareParagraph.helpersFor does not read it, so the care paragraph still names"
                + " DEFAULT_HELPERS whatever count the chat has. Derive the helpers from the"
                + " session count there: sessionsPerChat - 1, and DEFAULT_SESSIONS_PER_CHAT - 1"
                + " while it is unset");
    }

    @Test
    void theTripwireFiresOnATreeWithTheSessionCountAndAParagraphThatIgnoresIt() {
        String withCount = "List<String> toolGroupsOff,\n        Integer sessionsPerChat) {";
        String withoutCount = "List<String> toolGroupsOff) {";
        String ignores = "public static int helpersFor(SpectroConfig config) { return DEFAULT_HELPERS; }";
        String reads = "Integer count = config.sessionsPerChat();";
        assertTrue(missingSessionCountWiring(withCount, ignores).isPresent(),
                "the tripwire stayed quiet on the tree it exists for");
        assertEquals(Optional.empty(), missingSessionCountWiring(withCount, reads));
        assertEquals(Optional.empty(), missingSessionCountWiring(withoutCount, ignores));
    }

    @Test
    void theParagraphReadsTheSessionCountWheneverTheConfigHasOne() throws IOException {
        Path root = repoRoot();
        assumeTrue(root != null, "not running from a source checkout");
        String config = Files.readString(root.resolve(
                "spectro-core/src/main/java/dev/spectroscope/core/config/SpectroConfig.java"));
        String care = Files.readString(root.resolve(
                "spectro-core/src/main/java/dev/spectroscope/core/session/CareParagraph.java"));
        assertTrue(config.contains("List<String> toolGroupsOff"),
                "premise: this is the record that carries the settings keys");
        assertTrue(care.contains("public static int helpersFor("),
                "CareParagraph has no helpersFor(SpectroConfig), the one place the helper count"
                        + " is derived from the settings");
        Optional<String> missing = missingSessionCountWiring(config, care);
        assertFalse(missing.isPresent(), missing.orElse(""));
    }

    @Test
    void everyFaceOutsideTheCoreTakesTheHelperCountFromTheOneDerivation() throws IOException {
        // The faces outside spectro-core are the ones that offer spawn tools
        // (the browser session, its System context panel, the REPL). Inside the
        // core, the headless runner and the child build offer none, and the
        // embedded facade refuses the key.
        Path root = repoRoot();
        assumeTrue(root != null, "not running from a source checkout");
        List<String> faces = new ArrayList<>();
        List<String> offenders = new ArrayList<>();
        for (Path file : mainSources(root)) {
            String rel = root.relativize(file).toString();
            String text = Files.readString(file);
            boolean core = rel.startsWith("spectro-core/");
            boolean owner = rel.endsWith("/core/session/CareParagraph.java")
                    || rel.endsWith("/core/Agent.java");
            if (!owner && text.contains("DEFAULT_HELPERS")) {
                offenders.add(rel + " names DEFAULT_HELPERS itself");
            }
            if (!core && CARE_CALL.matcher(text).find()) {
                faces.add(rel);
                if (!text.contains(DERIVATION)) {
                    offenders.add(rel + " wires the care paragraph without " + DERIVATION + "...)");
                }
            }
        }
        assertTrue(faces.stream().anyMatch(rel -> rel.endsWith("/SessionConnection.java")),
                "premise: the walk found the browser session among the faces: " + faces);
        assertTrue(faces.stream().anyMatch(rel -> rel.endsWith("/SpectroCli.java")),
                "premise: the walk found the REPL among the faces: " + faces);
        assertEquals(List.of(), offenders);
    }

    private static List<Path> mainSources(Path root) throws IOException {
        List<Path> out = new ArrayList<>();
        try (Stream<Path> modules = Files.list(root)) {
            for (Path module : modules.filter(Files::isDirectory).sorted().toList()) {
                Path main = module.resolve("src/main/java");
                if (!Files.isDirectory(main)) {
                    continue;
                }
                try (Stream<Path> files = Files.walk(main)) {
                    files.filter(path -> path.toString().endsWith(".java")).sorted().forEach(out::add);
                }
            }
        }
        return out;
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
