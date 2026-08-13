package dev.spectroscope.server;

import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;
import java.util.Map;
import java.util.concurrent.TimeUnit;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * The SearXNG setup the settings page prints (card 203) — the same treatment
 * the Langfuse stack next door gets, for the same reason: the script is the
 * only thing between a user and a container, so its properties are asserted
 * rather than reviewed.
 *
 * <p>One property matters more than all the others here, and it is criterion 7
 * of the card: the paste has to yield an instance the product can QUERY, not
 * one it can browse. Stock SearXNG lists {@code html} under
 * {@code search.formats} and answers <b>403</b> to every request for a format
 * that is not on that list — measured against the real image on 2026-08-13,
 * where the same instance answered a browser's plain search with 200. So the
 * generated settings file is checked for the one line that separates those two
 * outcomes, and the check runs against a file the script really wrote, through
 * {@code --configure-only}, with no Docker daemon anywhere near it.</p>
 */
class SearxngSetupDriftTest {

    static final Path SCRIPT = LangfuseComposeDriftTest.repoRoot().resolve("samples/09-searxng/install.sh");
    static final Path COMPOSE =
            LangfuseComposeDriftTest.repoRoot().resolve("samples/09-searxng/docker-compose.yml");

    private static String read(Path file) throws IOException {
        assertTrue(Files.exists(file), "must ship: " + file);
        return Files.readString(file);
    }

    @Test
    void theSetupShipsAndTheInstallerIsExecutable() throws IOException {
        assertTrue(Files.exists(COMPOSE), "missing " + COMPOSE);
        assertTrue(Files.isExecutable(SCRIPT), "the installer must be executable: " + SCRIPT);
    }

    @Test
    void theScriptParses() throws Exception {
        assertEquals(0, run(Path.of("/tmp"), List.of("bash", "-n", SCRIPT.toString()), null).exit(),
                "bash -n rejected the installer");
    }

    @Test
    void itStopsOnTheFirstError() throws IOException {
        assertTrue(read(SCRIPT).contains("set -euo pipefail"),
                "a half-written settings file that reports success is the failure mode this closes");
    }

    @Test
    void theImageIsPinnedByDigestBecauseLatestMovesEveryWeek() throws IOException {
        String compose = read(COMPOSE);
        assertTrue(compose.contains("searxng/searxng@sha256:"),
                "searxng/searxng:latest is a rolling tag; a digest is a version");
        assertFalse(compose.contains("image: docker.io/searxng/searxng:latest"),
                "a floating tag makes \"the version that worked yesterday\" unknowable");
    }

    @Test
    void nothingIsPublishedBeyondLoopback() throws IOException {
        // A metasearch proxy fetches attacker-influenced URLs for a living, and
        // this one is meant for one reader on one machine.
        assertTrue(read(COMPOSE).contains("\"127.0.0.1:${SEARXNG_PORT"),
                "the published port must bind loopback only");
    }

    @Test
    void configureOnlyWritesASettingsFileThatTurnsJsonOn(@TempDir Path home) throws Exception {
        // THE test of this file. Everything else here is hygiene; this is
        // criterion 7 in the only form a test can hold it: run the configure
        // half for real and read what it produced.
        Path work = Files.createDirectory(home.resolve("work"));
        Result configured = run(work, List.of(SCRIPT.toString(), "--configure-only"),
                Map.of("HOME", Files.createDirectory(home.resolve("home")).toString()));

        assertEquals(0, configured.exit(), configured.output());
        Path settings = work.resolve("searxng/settings.yml");
        assertTrue(Files.exists(settings), "the settings file is the whole point:\n" + configured.output());

        String yaml = Files.readString(settings);
        assertTrue(yaml.contains("formats:"), "got:\n" + yaml);
        assertTrue(yaml.lines().anyMatch(l -> l.strip().equals("- json")),
                "without json under search.formats the instance answers 403 to every API call:\n" + yaml);
        assertTrue(yaml.lines().anyMatch(l -> l.strip().equals("- html")),
                "html stays on: a human still has to be able to open the thing:\n" + yaml);
    }

    @Test
    void theSecretKeyIsGeneratedHereAndIsNotAPlaceholder(@TempDir Path home) throws Exception {
        // SearXNG refuses to start on its shipped placeholder, and a secret
        // baked into a repository is not a secret anywhere.
        assertTrue(read(SCRIPT).contains("openssl rand"),
                "the instance key must be generated on the user's machine");

        Path work = Files.createDirectory(home.resolve("work"));
        assertEquals(0, run(work, List.of(SCRIPT.toString(), "--configure-only"),
                Map.of("HOME", Files.createDirectory(home.resolve("home")).toString())).exit());
        String yaml = Files.readString(work.resolve("searxng/settings.yml"));

        assertFalse(yaml.contains("ultrasecret"), "the upstream placeholder must not survive:\n" + yaml);
        String key = yaml.lines().filter(l -> l.strip().startsWith("secret_key:"))
                .findFirst().orElseThrow().replaceAll(".*secret_key:\\s*\"?([0-9a-f]+)\"?.*", "$1");
        assertEquals(64, key.length(), "32 bytes of hex, got: " + key.length() + " chars");
    }

    @Test
    void twoConfigureRunsKeepTheFirstIdentity(@TempDir Path home) throws Exception {
        // Idempotence, proven rather than asserted. The secret key is this
        // instance's identity: rotating it on a re-run invalidates every
        // preferences cookie it has handed out.
        Path work = Files.createDirectory(home.resolve("work"));
        Path fakeHome = Files.createDirectory(home.resolve("home"));
        Map<String, String> env = Map.of("HOME", fakeHome.toString());

        assertEquals(0, run(work, List.of(SCRIPT.toString(), "--configure-only"), env).exit());
        String first = Files.readString(work.resolve("searxng/settings.yml"));

        Result again = run(work, List.of(SCRIPT.toString(), "--configure-only"), env);
        assertEquals(0, again.exit(), again.output());
        assertEquals(first, Files.readString(work.resolve("searxng/settings.yml")),
                "a re-run must not rotate the instance's identity");
    }

    @Test
    void aHandEditedSettingsFileWithoutJsonIsRefusedRatherThanReused(@TempDir Path home) throws Exception {
        // The realistic bad state: a settings.yml from before this script, or
        // edited since. Reusing it silently produces a browsable instance that
        // answers the product 403 — which is precisely the outcome the whole
        // directory exists to prevent, arrived at through the happy path.
        Path work = Files.createDirectory(home.resolve("work"));
        Files.createDirectories(work.resolve("searxng"));
        Files.writeString(work.resolve("searxng/settings.yml"), """
                use_default_settings: true
                server:
                  secret_key: "deadbeef"
                search:
                  formats:
                    - html
                """);

        Result refused = run(work, List.of(SCRIPT.toString(), "--configure-only"),
                Map.of("HOME", Files.createDirectory(home.resolve("home")).toString()));

        assertNotEquals(0, refused.exit(),
                "a settings file that cannot serve the API must not report success:\n" + refused.output());
        assertTrue(refused.output().contains("search.formats"),
                "the message must name the setting to add:\n" + refused.output());
    }

    @Test
    void itNeverWritesAnythingIntoSettingsJson() throws IOException {
        // The address belongs in ~/.spectro/.env like the Langfuse endpoint
        // beside it; the settings DOCUMENT is the user's to edit, and the page
        // writes it through the API.
        assertFalse(read(SCRIPT).contains("settings.json"),
                "the installer hands over through ~/.spectro/.env, never by editing a settings document");
    }

    @Test
    void itWaitsForTheAnswerShapeAndNotForThePort() throws IOException {
        // A container that booted with json off answers the port instantly,
        // with 403. A readiness check that only asked "is it up" would call that
        // a success and write a dead address into a 0600 file.
        String script = read(SCRIPT);
        assertTrue(script.contains("format=json"), "the probe must ask for the format it needs");
        assertTrue(script.contains("\"results\""), "and must see a results array before handing over");
        assertTrue(script.contains("SPECTRO_SEARXNG_URL"), "the address it hands over");
    }

    @Test
    void theVariableTheInstallerWritesIsTheOneTheProductReadsBack() throws IOException {
        // Review finding F1, and the reason this file needed one more test: every
        // assertion above holds the WRITING end. The installer wrote
        // SPECTRO_SEARXNG_URL into ~/.spectro/.env, printed that it had, and told
        // the user to restart — and the address then reached nothing, because that
        // file was read back by name for API KEYS only and an address is not an API
        // key. So the name is taken out of the script and handed to the real
        // loader: rename it on either end and this goes red.
        String written = read(SCRIPT).lines()
                .map(line -> line.replaceAll("^echo \"([A-Z0-9_]+)=\\$url\".*$", "$1"))
                .filter(name -> name.startsWith("SPECTRO_") && !name.contains(" "))
                .findFirst()
                .orElseThrow(() -> new AssertionError("the installer no longer writes a SPECTRO_* "
                        + "line into ~/.spectro/.env; this test's premise is gone"));

        // The env layer reads the process environment first, so an exported address
        // on the machine running the suite would answer instead of the file.
        org.junit.jupiter.api.Assumptions.assumeTrue(System.getenv(written) == null,
                written + " is exported in this JVM; the file half cannot be observed");

        Path dotEnv = dev.spectroscope.core.config.SpectroConfig.dotEnvPath();
        try {
            Files.createDirectories(dotEnv.getParent());
            Files.writeString(dotEnv, written + "=http://written-by-the-installer.example:8888\n");

            assertEquals("http://written-by-the-installer.example:8888",
                    dev.spectroscope.core.config.SpectroConfig
                            .load(dev.spectroscope.core.config.SpectroConfig.Overrides.none())
                            .searxngUrl(),
                    "the installer's channel must be a channel the product reads");
        } finally {
            Files.deleteIfExists(dotEnv);
        }
    }

    @Test
    void noJavaSourceNamesASamplePathThatDoesNotExist() throws IOException {
        // Card 193 shipped this same defect and card 203 repeated it: the sample was
        // renumbered 07 -> 09 (07 was already Phoenix), the TypeScript constant and
        // samples/README.md were updated, and two Javadoc pointers kept sending the
        // reader to a directory that no longer exists. Nothing was watching a path
        // inside a comment, so this watches all of them.
        Path root = LangfuseComposeDriftTest.repoRoot();
        java.util.regex.Pattern reference = java.util.regex.Pattern.compile("samples/[0-9]{2}-[a-z0-9-]+");
        java.util.List<String> stale = new java.util.ArrayList<>();
        for (String module : List.of("spectro-core", "spectro-server", "spectro-cli")) {
            try (java.util.stream.Stream<Path> files = Files.walk(root.resolve(module).resolve("src"))) {
                for (Path file : files.filter(p -> p.toString().endsWith(".java")).toList()) {
                    java.util.regex.Matcher hit = reference.matcher(Files.readString(file));
                    while (hit.find()) {
                        if (!Files.exists(root.resolve(hit.group()))) {
                            stale.add(root.relativize(file) + " -> " + hit.group());
                        }
                    }
                }
            }
        }
        assertTrue(stale.isEmpty(), "a comment pointing at a sample that is not there: " + stale);
    }

    @Test
    void itUsesTheComposePlugin() throws IOException {
        String script = read(SCRIPT);
        assertTrue(script.contains("docker compose"), "compose is a docker CLI plugin");
        assertFalse(script.contains("docker-compose "),
                "the standalone docker-compose binary is not what a current install has");
    }

    /** One finished process: exit code plus its merged output. */
    record Result(int exit, String output) {}

    private static Result run(Path cwd, List<String> command, Map<String, String> env) throws Exception {
        ProcessBuilder builder = new ProcessBuilder(command).directory(cwd.toFile())
                .redirectErrorStream(true);
        if (env != null) {
            builder.environment().putAll(env);
        }
        Process process = builder.start();
        String output = new String(process.getInputStream().readAllBytes());
        assertTrue(process.waitFor(120, TimeUnit.SECONDS), "the script hung:\n" + output);
        return new Result(process.exitValue(), output);
    }
}
