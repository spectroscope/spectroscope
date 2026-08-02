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
    void aDotlessAdminAddressIsRefusedBeforeAnythingIsWritten(@TempDir Path home) throws Exception {
        // The knob the test above never touched. LANGFUSE_ADMIN_EMAIL is
        // documented at install.sh:29 and README.md:50, and admin@localhost is
        // the realistic thing to type. Without this guard the address is written
        // verbatim, five services come up healthy, langfuse-web crash-loops on
        // "Invalid environment variables", and the health loop spins for four
        // minutes before failing. The refusal has to come before the write, so
        // there is no half-configured .env left behind either.
        Path work = Files.createDirectory(home.resolve("work"));
        Path fakeHome = Files.createDirectory(home.resolve("home"));

        Result refused = run(work, List.of(SCRIPT.toString(), "--configure-only"),
                java.util.Map.of("HOME", fakeHome.toString(),
                        "LANGFUSE_ADMIN_EMAIL", "admin@localhost"));

        assertNotEquals(0, refused.exit(), "a dotless domain must not configure a stack:\n" + refused.output());
        assertTrue(refused.output().contains("LANGFUSE_ADMIN_EMAIL"),
                "the message must name the variable the operator set:\n" + refused.output());
        assertFalse(Files.exists(work.resolve(".env")),
                "nothing may be written when the address cannot boot the stack");
        assertFalse(Files.exists(fakeHome.resolve(".spectro/.env")),
                "and no endpoint may be handed over either");
    }

    @Test
    void aValidAdminAddressOverrideIsAccepted(@TempDir Path home) throws Exception {
        // The guard must refuse a shape, not the knob itself.
        Path work = Files.createDirectory(home.resolve("work"));
        Path fakeHome = Files.createDirectory(home.resolve("home"));

        Result ok = run(work, List.of(SCRIPT.toString(), "--configure-only"),
                java.util.Map.of("HOME", fakeHome.toString(),
                        "LANGFUSE_ADMIN_EMAIL", "ops@example.com"));

        assertEquals(0, ok.exit(), ok.output());
        assertTrue(Files.readString(work.resolve(".env")).contains("LANGFUSE_INIT_USER_EMAIL=ops@example.com"));
    }

    @Test
    void aReRunWithADifferentPortIsRefusedRatherThanSplit(@TempDir Path home) throws Exception {
        // Measured 2026-08-02 with `docker compose config`: the process
        // environment outranks --env-file, so an exported LANGFUSE_PORT moves
        // the published port while this script keeps reading the reused .env.
        // The stack would come up on the caller's port and ~/.spectro/.env would
        // be left holding a dead endpoint on the file's port, announced as a
        // success. README.md:33 promises "Re-running is safe", and a port clash
        // on 3000 is exactly what sends an operator back with this knob.
        Path work = Files.createDirectory(home.resolve("work"));
        Path fakeHome = Files.createDirectory(home.resolve("home"));

        assertEquals(0, configureOnly(work, fakeHome).exit());
        String handedOver = Files.readString(fakeHome.resolve(".spectro/.env"));
        assertTrue(handedOver.contains("localhost:3000/api/public/otel"), handedOver);

        Result second = run(work, List.of(SCRIPT.toString(), "--configure-only"),
                java.util.Map.of("HOME", fakeHome.toString(), "LANGFUSE_PORT", "3100"));

        assertNotEquals(0, second.exit(),
                "a port the reused .env does not know must not report success:\n" + second.output());
        assertTrue(second.output().contains("3100") && second.output().contains("3000"),
                "the message must name both ports:\n" + second.output());
        assertEquals(handedOver, Files.readString(fakeHome.resolve(".spectro/.env")),
                "the credential file must not be left pointing at a port nothing will listen on");
    }

    @Test
    void aReRunWithTheSamePortIsStillFine(@TempDir Path home) throws Exception {
        // The guard is about disagreement, not about setting the variable.
        Path work = Files.createDirectory(home.resolve("work"));
        Path fakeHome = Files.createDirectory(home.resolve("home"));

        assertEquals(0, run(work, List.of(SCRIPT.toString(), "--configure-only"),
                java.util.Map.of("HOME", fakeHome.toString(), "LANGFUSE_PORT", "3100")).exit());
        assertTrue(Files.readString(fakeHome.resolve(".spectro/.env")).contains("localhost:3100"));

        Result again = run(work, List.of(SCRIPT.toString(), "--configure-only"),
                java.util.Map.of("HOME", fakeHome.toString(), "LANGFUSE_PORT", "3100"));
        assertEquals(0, again.exit(), again.output());
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

    /** Every knob the installer reads. Cleared before each run so a value
     *  exported on the machine running the suite cannot decide the outcome:
     *  ProcessBuilder inherits the parent environment, so without this a
     *  developer with LANGFUSE_PORT set would see these tests pass or fail for
     *  reasons that have nothing to do with the script. */
    private static final List<String> INSTALLER_KNOBS =
            List.of("LANGFUSE_PORT", "MINIO_PORT", "LANGFUSE_ADMIN_EMAIL", "COMPOSE_PROJECT_NAME",
                    "DOCKER_HOST");

    private static Result run(Path cwd, List<String> command, java.util.Map<String, String> extraEnv)
            throws IOException, InterruptedException {
        ProcessBuilder builder = new ProcessBuilder(command).directory(cwd.toFile()).redirectErrorStream(true);
        INSTALLER_KNOBS.forEach(builder.environment()::remove);
        if (extraEnv != null) {
            builder.environment().putAll(extraEnv);
        }
        Process process = builder.start();
        String output = new String(process.getInputStream().readAllBytes());
        assertTrue(process.waitFor(60, TimeUnit.SECONDS), "the installer hung: " + command);
        return new Result(process.exitValue(), output);
    }
}
