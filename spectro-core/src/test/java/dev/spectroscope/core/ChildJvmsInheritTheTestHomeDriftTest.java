package dev.spectroscope.core;

import org.junit.jupiter.api.Test;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.stream.Stream;

import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * Card 235, criterion 2: every child JVM a test starts carries the redirected
 * home with it.
 *
 * <p>The Gradle redirect covers the TEST JVM only — a {@code ProcessBuilder}
 * child inherits the classpath it is handed and none of the parent's system
 * properties. The node-proof child ran {@code NodeCommand.execute} with a real
 * {@code SessionStore} against the operator's real {@code ~/.spectro} for
 * three weeks that way (CODE-REVIEW-2026-08-14, finding 5).
 *
 * <p>The pin is textual, in the house drift style: any test source that builds
 * a {@code …/bin/java} command line must also carry {@code -Duser.home=}
 * somewhere in the same file. File granularity is deliberate — command lists
 * are assembled in helpers, and the property may be threaded through one. The
 * live half of the proof is NodeProcessProofTest, which asserts the child's
 * session lands under the redirected home.
 */
class ChildJvmsInheritTheTestHomeDriftTest {

    @Test
    void everyTestSourceThatStartsAChildJvmPassesTheRedirectedHome() throws IOException {
        Path root = repoRoot();
        List<String> offenders = new ArrayList<>();
        for (String module : List.of("spectro-core", "spectro-cli", "spectro-server",
                "spectro-mcp-notes", "spectro-orchestrator")) {
            Path tests = root.resolve(module).resolve("src/test/java");
            if (!Files.isDirectory(tests)) {
                continue;
            }
            try (Stream<Path> walk = Files.walk(tests)) {
                walk.filter(p -> p.toString().endsWith(".java"))
                        .filter(p -> !p.getFileName().toString()
                                .equals("ChildJvmsInheritTheTestHomeDriftTest.java"))
                        .forEach(p -> {
                            String src = readQuietly(p);
                            boolean startsAJvm = src.contains("/bin/java\"")
                                    || src.contains("\"bin\" + File.separator + \"java\"");
                            if (startsAJvm && !src.contains("-Duser.home=")) {
                                offenders.add(root.relativize(p).toString());
                            }
                        });
            }
        }
        assertTrue(offenders.isEmpty(),
                "these test sources start a child JVM without handing it the redirected"
                        + " user.home — the child would write into the real ~/.spectro: "
                        + offenders);
    }

    /** Walk up from the module dir to the directory that carries the Gradle settings. */
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

    private static String readQuietly(Path file) {
        try {
            return Files.readString(file, StandardCharsets.UTF_8);
        } catch (IOException e) {
            throw new java.io.UncheckedIOException(e);
        }
    }
}
