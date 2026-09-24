package dev.spectroscope.server.starter;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.concurrent.TimeUnit;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * A throwaway checkout for the build scripts (card 398): the scripts under test
 * copied in from this repository, a {@code spectro-server/build.gradle.kts} that
 * declares a version, and, when asked for, a git history with branches and tags.
 *
 * <p>Git runs with the machine's global and system configuration switched off,
 * so a developer's {@code commit.gpgsign} or default branch name cannot decide
 * an outcome.
 */
final class ScriptTree {

    /** Environment the scripts read. Cleared before every run, because
     *  ProcessBuilder inherits the parent environment. */
    private static final List<String> KNOBS = List.of("SPECTRO_RELEASE", "VERSION", "SIGN_IDENTITY",
            "NOTARY_PROFILE", "SKIP_DESKTOP", "GIT_DIR", "GIT_WORK_TREE");

    final Path dir;

    private ScriptTree(Path dir) {
        this.dir = dir;
    }

    /** The product repository this test runs in. */
    static Path repoRoot() {
        Path here = Path.of("").toAbsolutePath();
        for (Path candidate = here; candidate != null; candidate = candidate.getParent()) {
            if (Files.isRegularFile(candidate.resolve("settings.gradle.kts"))) {
                return candidate;
            }
        }
        throw new IllegalStateException("no settings.gradle.kts above " + here);
    }

    /**
     * A tree with the named scripts copied from {@code scripts/} and a server
     * build file declaring {@code version}. No git yet.
     */
    static ScriptTree of(Path dir, String version, String... scripts) throws IOException {
        Files.createDirectories(dir.resolve("scripts"));
        Files.createDirectories(dir.resolve("spectro-server"));
        for (String script : scripts) {
            Path target = dir.resolve("scripts").resolve(script);
            Files.copy(repoRoot().resolve("scripts").resolve(script), target,
                    StandardCopyOption.REPLACE_EXISTING);
            assertTrue(target.toFile().setExecutable(true), "chmod +x " + target);
        }
        Files.writeString(dir.resolve("spectro-server/build.gradle.kts"),
                "group = \"dev.spectroscope\"\nversion = \"" + version + "\"\n");
        return new ScriptTree(dir);
    }

    /** Writes an executable file, creating its folder. */
    ScriptTree executable(String relative, String content) throws IOException {
        Path file = dir.resolve(relative);
        Files.createDirectories(file.getParent());
        Files.writeString(file, content);
        assertTrue(file.toFile().setExecutable(true), "chmod +x " + file);
        return this;
    }

    /** {@code git init} on {@code branch} and one commit of everything. */
    ScriptTree commitOn(String branch) throws Exception {
        git("init", "-q", "-b", branch);
        return commit("first");
    }

    ScriptTree commit(String message) throws Exception {
        Files.writeString(dir.resolve("CHANGES"), message + "\n",
                java.nio.file.StandardOpenOption.CREATE, java.nio.file.StandardOpenOption.APPEND);
        git("add", "-A");
        git("commit", "-q", "-m", message);
        return this;
    }

    /** Runs git in the tree and returns its trimmed stdout; fails on a non-zero exit. */
    String git(String... args) throws Exception {
        List<String> command = new ArrayList<>(List.of("git", "-c", "commit.gpgsign=false",
                "-c", "tag.gpgsign=false", "-c", "user.name=test", "-c", "user.email=test@example.com"));
        command.addAll(List.of(args));
        Run run = run(command, Map.of());
        assertEquals(0, run.exit(), "git " + String.join(" ", args) + " failed:\n" + run.stderr());
        return run.stdout().trim();
    }

    /** The outcome of one process: exit code, stdout and stderr kept apart. */
    record Run(int exit, String stdout, String stderr) {
        String both() {
            return "stdout:\n" + stdout + "\nstderr:\n" + stderr;
        }
    }

    /** Runs a command in the tree with the script knobs cleared and {@code env} added. */
    Run run(List<String> command, Map<String, String> env) throws IOException, InterruptedException {
        Path err = Files.createTempFile("script-tree", ".err");
        try {
            ProcessBuilder builder = new ProcessBuilder(command).directory(dir.toFile())
                    .redirectError(err.toFile());
            KNOBS.forEach(builder.environment()::remove);
            builder.environment().put("GIT_CONFIG_GLOBAL", "/dev/null");
            builder.environment().put("GIT_CONFIG_NOSYSTEM", "1");
            builder.environment().putAll(env);
            Process process = builder.start();
            process.getOutputStream().close();
            String out = new String(process.getInputStream().readAllBytes(), StandardCharsets.UTF_8);
            assertTrue(process.waitFor(120, TimeUnit.SECONDS), "hung: " + command);
            return new Run(process.exitValue(), out,
                    Files.readString(err, StandardCharsets.UTF_8));
        } finally {
            Files.deleteIfExists(err);
        }
    }

    /** Runs {@code bash scripts/<script>} in the tree. */
    Run script(String script, Map<String, String> env) throws IOException, InterruptedException {
        return run(List.of("bash", "scripts/" + script), env);
    }

    /** True when the machine running the suite has bash and git on the PATH. */
    static boolean toolsPresent() {
        for (String tool : List.of("bash", "git")) {
            try {
                Process p = new ProcessBuilder(tool, "--version").redirectErrorStream(true).start();
                p.getInputStream().readAllBytes();
                if (!p.waitFor(20, TimeUnit.SECONDS) || p.exitValue() != 0) {
                    return false;
                }
            } catch (IOException e) {
                return false;
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
                return false;
            }
        }
        return true;
    }
}
