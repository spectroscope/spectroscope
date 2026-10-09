package dev.spectroscope.core.copilot;

import dev.spectroscope.core.provider.CopilotProvider;
import org.junit.jupiter.api.Test;

import java.io.IOException;
import java.lang.reflect.Method;
import java.lang.reflect.Modifier;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.TreeMap;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import java.util.stream.Stream;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * Card 495, criteria 3 and 4, held for the code that wires Copilot in later
 * (card 496): a main source builds a {@link CopilotProvider} or its options
 * only inside {@link CopilotAccount}. Anywhere else, a plain
 * {@code new CopilotProvider.Options(model, path, null, true)} would put the
 * Copilot CLI's stored sign-in, or the GitHub CLI's account behind it, on a run
 * the user never chose. The way in for other code is
 * {@link CopilotAccount#provider(String, String)}.
 *
 * <p>Comments are stripped before the match. The walk covers every
 * {@code spectro-*} module's {@code src/main/java}. This test reads other
 * modules' sources, so Gradle's up-to-date check does not re-run it when only
 * those change; the gate runs it with {@code --rerun-tasks}.
 */
class CopilotProviderIsBuiltByTheAccountDriftTest {

    /** A constructor call of the provider, or of its options record by either spelling. */
    private static final Pattern CONSTRUCTION = Pattern.compile(
            "new\\s+CopilotProvider\\s*\\(|new\\s+(?:CopilotProvider\\s*\\.\\s*)?Options\\s*\\(");

    /** The one file allowed to build them. */
    private static final String ACCOUNT = "spectro-core/src/main/java/dev/spectroscope/core/copilot/CopilotAccount.java";

    @Test
    void onlyTheAccountBuildsACopilotProviderOrItsOptions() throws IOException {
        Map<String, Integer> found = new TreeMap<>();
        for (Path source : mainSources()) {
            String code = stripComments(Files.readString(source, StandardCharsets.UTF_8));
            if (!code.contains("CopilotProvider")) {
                continue;
            }
            int count = 0;
            Matcher m = CONSTRUCTION.matcher(code);
            while (m.find()) {
                count++;
            }
            if (count > 0) {
                found.put(repoRoot().relativize(source).toString(), count);
            }
        }

        assertTrue(found.containsKey(ACCOUNT), "the account itself builds them; the pattern finds nothing: " + found);
        found.remove(ACCOUNT);
        assertEquals(Map.of(), found, "main sources that build a Copilot provider outside the account");
    }

    @Test
    void theAccountOffersTheProviderItBuilds() throws NoSuchMethodException {
        Method provider = CopilotAccount.class.getMethod("provider", String.class, String.class);

        assertEquals(CopilotProvider.class, provider.getReturnType());
        assertTrue(Modifier.isPublic(provider.getModifiers()));
    }

    /** Every main-source java file in the repository's modules. */
    private static List<Path> mainSources() throws IOException {
        List<Path> found = new ArrayList<>();
        try (Stream<Path> modules = Files.list(repoRoot())) {
            for (Path module : modules.filter(Files::isDirectory)
                    .filter(dir -> dir.getFileName().toString().startsWith("spectro-"))
                    .sorted().toList()) {
                Path main = module.resolve("src/main/java");
                if (!Files.isDirectory(main)) {
                    continue;
                }
                try (Stream<Path> walk = Files.walk(main)) {
                    walk.filter(path -> path.toString().endsWith(".java")).sorted().forEach(found::add);
                }
            }
        }
        assertTrue(found.size() > 100, "the walk found only " + found.size() + " main sources");
        return found;
    }

    private static String stripComments(String source) {
        return source.replaceAll("(?s)/\\*.*?\\*/", "").replaceAll("(?m)//.*$", "");
    }

    private static Path repoRoot() {
        Path dir = Path.of(System.getProperty("user.dir")).toAbsolutePath();
        while (dir != null && !Files.isRegularFile(dir.resolve("settings.gradle.kts"))) {
            dir = dir.getParent();
        }
        if (dir == null) {
            throw new IllegalStateException("no settings.gradle.kts above " + System.getProperty("user.dir"));
        }
        return dir;
    }
}
