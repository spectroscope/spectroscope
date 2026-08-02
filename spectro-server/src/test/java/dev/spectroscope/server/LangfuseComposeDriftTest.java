package dev.spectroscope.server;

import org.junit.jupiter.api.Test;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;
import java.util.Locale;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * The drift gate for the shipped Langfuse stack (card 137), read off disk the
 * way {@code about.drift.test.ts} reads the licence files.
 *
 * <p>A compose file is not code we can unit test, and it is also not inert: it
 * decides whether a first boot works and whether the credentials it boots with
 * are ours or the upstream example's. Both known first-boot traps live in the
 * FILE, not in an untracked {@code .env}, so both are asserted here:
 *
 * <ol>
 *   <li>{@code DATABASE_URL} carries its own {@code postgres:postgres} default
 *       upstream, so setting only {@code POSTGRES_PASSWORD} crash-loops
 *       langfuse-web on Prisma P1000.</li>
 *   <li>MinIO's root password must be mirrored into all three
 *       {@code LANGFUSE_S3_*_SECRET_ACCESS_KEY} variables, or OTLP ingestion
 *       500s while every health check stays green.</li>
 * </ol>
 *
 * <p>The file existing is asserted rather than assumed: a skip when the sample
 * is missing would turn the whole gate into decoration.
 */
class LangfuseComposeDriftTest {

    /** The repo root, found by walking up to the Gradle settings file, so the
     *  test does not depend on which directory the runner starts in. */
    static Path repoRoot() {
        Path dir = Path.of("").toAbsolutePath();
        while (dir != null && !Files.exists(dir.resolve("settings.gradle.kts"))) {
            dir = dir.getParent();
        }
        assertTrue(dir != null, "repo root (the directory holding settings.gradle.kts) not found");
        return dir;
    }

    static final Path COMPOSE = repoRoot().resolve("samples/06-langfuse/docker-compose.yml");

    /** Credentials that exist in the owner's private workspace or in the upstream
     *  example. None of them may ship. */
    static final List<String> NEVER_SHIP = List.of(
            "pk-lf-spectro-local-dev", "spectro-local-dev", "chris@spectroscope.ai",
            "miniosecret", "postgres:postgres", "myredissecret", "mysalt", "mysecret");

    private static String read() throws IOException {
        assertTrue(Files.exists(COMPOSE), "the sample stack must ship: " + COMPOSE);
        return Files.readString(COMPOSE);
    }

    private static List<String> linesMatching(String needle) throws IOException {
        return read().lines().map(String::strip)
                .filter(l -> !l.startsWith("#"))
                .filter(l -> l.contains(needle))
                .toList();
    }

    @Test
    void theComposeFileShips() throws IOException {
        assertTrue(Files.exists(COMPOSE), "missing " + COMPOSE);
        assertTrue(Files.size(COMPOSE) > 0, "empty " + COMPOSE);
    }

    @Test
    void everyImageIsPinnedByDigest() throws IOException {
        List<String> images = linesMatching("image:");
        assertFalse(images.isEmpty(), "no image lines at all");
        for (String image : images) {
            assertTrue(image.contains("@sha256:"),
                    "a floating tag is a different stack tomorrow: " + image);
        }
    }

    @Test
    void theDatabaseUrlInterpolatesThePostgresPassword() throws IOException {
        List<String> urls = linesMatching("DATABASE_URL");
        assertFalse(urls.isEmpty(), "DATABASE_URL is not set at all");
        for (String url : urls) {
            assertTrue(url.contains("${POSTGRES_PASSWORD"),
                    "trap 1: DATABASE_URL must not keep its own password, or web crash-loops P1000: " + url);
        }
    }

    @Test
    void allThreeS3SecretsComeFromOneVariable() throws IOException {
        List<String> secrets = linesMatching("_SECRET_ACCESS_KEY");
        assertEquals(3, secrets.size(), "langfuse reads three S3 secrets: event, media, batch export");
        for (String secret : secrets) {
            assertTrue(secret.contains("${MINIO_ROOT_PASSWORD"),
                    "trap 2: an S3 secret that does not mirror MINIO_ROOT_PASSWORD 500s ingestion: " + secret);
        }
    }

    @Test
    void allThreeS3KeyIdsComeFromOneVariable() throws IOException {
        List<String> ids = linesMatching("_ACCESS_KEY_ID");
        assertEquals(3, ids.size());
        for (String id : ids) {
            assertTrue(id.contains("${MINIO_ROOT_USER"),
                    "the access key id must mirror the MinIO root user: " + id);
        }
    }

    @Test
    void noSecretHasASilentDefault() throws IOException {
        List<String> secretNames = List.of("POSTGRES_PASSWORD", "CLICKHOUSE_PASSWORD", "REDIS_AUTH",
                "MINIO_ROOT_PASSWORD", "NEXTAUTH_SECRET", "SALT", "ENCRYPTION_KEY",
                "LANGFUSE_INIT_PROJECT_SECRET_KEY", "LANGFUSE_INIT_PROJECT_PUBLIC_KEY",
                "LANGFUSE_INIT_USER_PASSWORD");
        for (String line : read().lines().map(String::strip).toList()) {
            if (line.startsWith("#")) {
                continue;
            }
            for (String name : secretNames) {
                if (line.contains("${" + name + ":-")) {
                    throw new AssertionError(
                            "a secret with a :- default boots quietly with the example value: " + line);
                }
            }
        }
    }

    @Test
    void everySecretStopsComposeWhenUnset() throws IOException {
        // The other half of the same rule: not just "no silent default" but an
        // explicit ${VAR:?...} so compose refuses instead of booting half-configured.
        for (String name : List.of("POSTGRES_PASSWORD", "MINIO_ROOT_PASSWORD", "NEXTAUTH_SECRET",
                "ENCRYPTION_KEY", "SALT", "CLICKHOUSE_PASSWORD", "REDIS_AUTH")) {
            assertTrue(read().contains("${" + name + ":?"),
                    name + " must be a required interpolation (${" + name + ":?...})");
        }
    }

    @Test
    void noDevCredentialsAreShipped() throws IOException {
        String lower = read().toLowerCase(Locale.ROOT);
        for (String secret : NEVER_SHIP) {
            assertFalse(lower.contains(secret.toLowerCase(Locale.ROOT)),
                    "the shipped stack must not carry \"" + secret + "\"");
        }
    }

    @Test
    void theHostPortsAreConfigurable() throws IOException {
        // Stage verification runs a second stack beside a running one; a hard-coded
        // 3000 makes that impossible and makes the port conflict the user's problem.
        assertTrue(read().contains("${LANGFUSE_PORT"), "the web port must come from a variable");
        assertTrue(read().contains("${MINIO_PORT"), "the minio port must come from a variable");
    }
}
