package dev.spectroscope.server;

import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;
import java.util.Locale;
import java.util.concurrent.TimeUnit;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * The installer that configures the shipped Langfuse stack (card 137).
 *
 * <p>The script is the only thing between a user and six containers, so the
 * properties that matter are asserted rather than reviewed: it generates its own
 * secrets instead of shipping anyone's, it protects the files it writes, it never
 * puts a credential into {@code settings.json}, it stops on the first error, and
 * running it twice is safe. That last one is not cosmetic: a re-run that
 * regenerated the postgres password would leave the old password baked into the
 * existing volume and the stack would refuse to start.
 *
 * <p>{@code --configure-only} exists so this test can prove the configure half
 * end to end with no Docker daemon involved.
 */
class LangfuseInstallScriptTest {

    static final Path SCRIPT =
            LangfuseComposeDriftTest.repoRoot().resolve("samples/06-langfuse/install.sh");

    private static String read() throws IOException {
        assertTrue(Files.exists(SCRIPT), "the installer must ship: " + SCRIPT);
        return Files.readString(SCRIPT);
    }

    @Test
    void theInstallScriptShips() throws IOException {
        assertTrue(Files.exists(SCRIPT), "missing " + SCRIPT);
        assertTrue(Files.isExecutable(SCRIPT), "the installer must be executable: " + SCRIPT);
    }

    @Test
    void itGeneratesItsOwnSecrets() throws IOException {
        assertTrue(read().contains("openssl rand"),
                "secrets must be generated on the user's machine, never copied from an example");
    }

    @Test
    void itProtectsTheFilesItWrites() throws IOException {
        assertTrue(read().contains("chmod 600"), "the generated .env holds every secret in the stack");
    }

    @Test
    void itUsesTheComposePlugin() throws IOException {
        String script = read();
        assertTrue(script.contains("docker compose"), "compose is a docker CLI plugin");
        assertFalse(script.contains("docker-compose "),
                "the standalone docker-compose binary is not what a current install has");
    }

    @Test
    void itNeverWritesASecretIntoSettingsJson() throws IOException {
        assertFalse(read().contains("settings.json"),
                "a pk:sk pair belongs in the 0600 .env, not in a settings document");
    }

    @Test
    void itStopsOnTheFirstError() throws IOException {
        assertTrue(read().contains("set -euo pipefail"),
                "a half-configured stack that reports success is the failure mode this closes");
    }

    @Test
    void noDevCredentialsAreShipped() throws IOException {
        String lower = read().toLowerCase(Locale.ROOT);
        for (String secret : LangfuseComposeDriftTest.NEVER_SHIP) {
            assertFalse(lower.contains(secret.toLowerCase(Locale.ROOT)),
                    "the installer must not carry \"" + secret + "\"");
        }
    }

    @Test
    void theAdminAddressHasADomainLangfuseAccepts(@TempDir Path home) throws Exception {
        // Found live on 2026-08-02, not by reading the file: langfuse-web validates
        // this address at boot and refuses to start when the domain has no dot. The
        // stack looks fine while it happens (five services healthy, web crash-looping
        // on "Invalid environment variables"), so this guard is the cheap version of
        // that four-minute timeout.
        Path work = Files.createDirectory(home.resolve("work"));
        assertEquals(0, configureOnly(work, Files.createDirectory(home.resolve("home"))).exit());

        String email = Files.readString(work.resolve(".env")).lines()
                .filter(l -> l.startsWith("LANGFUSE_INIT_USER_EMAIL="))
                .map(l -> l.substring("LANGFUSE_INIT_USER_EMAIL=".length()))
                .findFirst().orElseThrow();
        assertTrue(email.matches("[^@\\s]+@[^@\\s.]+\\.[^@\\s.]+"),
                "langfuse refuses to boot on an address whose domain has no dot: " + email);
    }

    @Test
    void theScriptParses() throws IOException, InterruptedException {
        assertEquals(0, run(Path.of("/tmp"), List.of("bash", "-n", SCRIPT.toString()), null).exit(),
                "bash -n rejected the installer");
    }

    @Test
    void configuringTwiceKeepsTheFirstSecrets(@TempDir Path home) throws Exception {
        // Idempotence, proven rather than asserted: the second run must reuse the
        // first run's secrets. Regenerating them would strand the stack against a
        // volume that still carries the old postgres password.
        Path work = Files.createDirectory(home.resolve("work"));
        Path fakeHome = Files.createDirectory(home.resolve("home"));

        Result first = configureOnly(work, fakeHome);
        assertEquals(0, first.exit(), "first configure failed:\n" + first.output());
        String env1 = Files.readString(work.resolve(".env"));
        String spectroEnv1 = Files.readString(fakeHome.resolve(".spectro/.env"));

        Result second = configureOnly(work, fakeHome);
        assertEquals(0, second.exit(), "second configure failed:\n" + second.output());
        assertEquals(env1, Files.readString(work.resolve(".env")),
                "a re-run must not rotate the secrets the running volumes were built with");
        assertEquals(spectroEnv1, Files.readString(fakeHome.resolve(".spectro/.env")));
    }

    @Test
    void twoInstallsNeverShareASecret(@TempDir Path home) throws Exception {
        // The whole point of generating: two users, or one user twice from scratch,
        // must not end up with the same keys.
        Path a = Files.createDirectory(home.resolve("a"));
        Path b = Files.createDirectory(home.resolve("b"));
        Path homeA = Files.createDirectory(home.resolve("home-a"));
        Path homeB = Files.createDirectory(home.resolve("home-b"));

        assertEquals(0, configureOnly(a, homeA).exit());
        assertEquals(0, configureOnly(b, homeB).exit());

        assertNotEquals(Files.readString(a.resolve(".env")), Files.readString(b.resolve(".env")),
                "two fresh installs must not share secrets");
    }

    @Test
    void theGeneratedEnvIsOwnerOnlyAndCarriesNoExampleValue(@TempDir Path home) throws Exception {
        Path work = Files.createDirectory(home.resolve("work"));
        Path fakeHome = Files.createDirectory(home.resolve("home"));
        assertEquals(0, configureOnly(work, fakeHome).exit());

        Path env = work.resolve(".env");
        assertEquals(java.util.Set.of(java.nio.file.attribute.PosixFilePermission.OWNER_READ,
                        java.nio.file.attribute.PosixFilePermission.OWNER_WRITE),
                Files.getPosixFilePermissions(env), ".env holds every secret in the stack");
        assertEquals(java.util.Set.of(java.nio.file.attribute.PosixFilePermission.OWNER_READ,
                        java.nio.file.attribute.PosixFilePermission.OWNER_WRITE),
                Files.getPosixFilePermissions(fakeHome.resolve(".spectro/.env")),
                "the spectro handover file holds the pk:sk pair");

        String body = Files.readString(env).toLowerCase(Locale.ROOT);
        for (String secret : LangfuseComposeDriftTest.NEVER_SHIP) {
            assertFalse(body.contains(secret.toLowerCase(Locale.ROOT)),
                    "a generated .env must not contain \"" + secret + "\"");
        }
        assertTrue(Files.readString(fakeHome.resolve(".spectro/.env")).contains("SPECTRO_OTLP_ENDPOINT="),
                "the endpoint handover is the whole point of the configure step");
        assertFalse(Files.exists(fakeHome.resolve(".spectro/settings.json")),
                "the installer must not touch the settings document");
    }

    @Test
    void theStackIsNeverStartedByConfigureOnly(@TempDir Path home) throws Exception {
        // The fence for the whole card: nothing spectroscope ships starts a container
        // on its own. A fake `docker` earlier on PATH records any call.
        Path work = Files.createDirectory(home.resolve("work"));
        Path fakeHome = Files.createDirectory(home.resolve("home"));
        Path bin = Files.createDirectory(home.resolve("bin"));
        Path ledger = home.resolve("docker-calls.txt");
        Path fakeDocker = bin.resolve("docker");
        Files.writeString(fakeDocker, "#!/usr/bin/env bash\necho \"$@\" >> \"" + ledger + "\"\nexit 0\n");
        Files.setPosixFilePermissions(fakeDocker, java.nio.file.attribute.PosixFilePermissions.fromString("rwx------"));

        Result result = run(work, List.of(SCRIPT.toString(), "--configure-only"),
                java.util.Map.of("HOME", fakeHome.toString(),
                        "PATH", bin + ":" + System.getenv("PATH")));

        assertEquals(0, result.exit(), result.output());
        assertFalse(Files.exists(ledger), "--configure-only must not invoke docker at all");
    }

    private static Result configureOnly(Path work, Path fakeHome) throws Exception {
        return run(work, List.of(SCRIPT.toString(), "--configure-only"),
                java.util.Map.of("HOME", fakeHome.toString()));
    }

    private record Result(int exit, String output) { }

    private static Result run(Path cwd, List<String> command, java.util.Map<String, String> extraEnv)
            throws IOException, InterruptedException {
        ProcessBuilder builder = new ProcessBuilder(command).directory(cwd.toFile()).redirectErrorStream(true);
        if (extraEnv != null) {
            builder.environment().putAll(extraEnv);
        }
        Process process = builder.start();
        String output = new String(process.getInputStream().readAllBytes());
        assertTrue(process.waitFor(60, TimeUnit.SECONDS), "the installer hung: " + command);
        return new Result(process.exitValue(), output);
    }
}
