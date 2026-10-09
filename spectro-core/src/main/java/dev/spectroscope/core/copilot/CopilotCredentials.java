package dev.spectroscope.core.copilot;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.AtomicMoveNotSupportedException;
import java.nio.file.FileAlreadyExistsException;
import java.nio.file.Files;
import java.nio.file.NoSuchFileException;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import java.nio.file.attribute.PosixFilePermissions;
import java.util.Optional;
import java.util.UUID;

/**
 * The stored Copilot sign-in: one owner-only file beside the key file that
 * {@code SpectroConfig.writeApiKey} keeps.
 *
 * <p>The discipline is the same as for an API key (mode 0600), with one step
 * more: the file is written under a temporary name that is created with mode
 * 0600 and then moved over the old one, so no moment exists in which the token
 * sits in a file other users can read, and a crash leaves either the old or the
 * new file, never half of one.
 */
public final class CopilotCredentials {

    /** How the harness signs in to Copilot. */
    public enum Method {
        /** spectroscope's own device flow; the token lives in this file. */
        GITHUB,
        /** The Copilot CLI's own stored sign-in, chosen by the user; no token lives here. */
        CLI
    }

    /**
     * One stored sign-in. {@link #toString()} shows no token.
     *
     * @param method           how it was made
     * @param login            the GitHub login
     * @param accessToken      the token, null for {@link Method#CLI}
     * @param accessExpiresAt  epoch second the token expires, 0 when it does not
     * @param refreshToken     the refresh token, or null
     * @param refreshExpiresAt epoch second the refresh token expires, 0 when unknown
     */
    public record Stored(Method method, String login, String accessToken, long accessExpiresAt,
                         String refreshToken, long refreshExpiresAt) {
        @Override
        public String toString() {
            return "Stored[method=" + method + ", login=" + login + ", token=" + (accessToken != null)
                    + ", accessExpiresAt=" + accessExpiresAt + ", refreshable=" + (refreshToken != null)
                    + ", refreshExpiresAt=" + refreshExpiresAt + "]";
        }
    }

    private static final ObjectMapper JSON = new ObjectMapper();

    private final Path file;

    /**

     * The sign-in kept in one file.

     *

     * @param file where the sign-in is kept

     */
    public CopilotCredentials(Path file) {
        this.file = file;
    }

    /**

     * Returns {@code ~/.spectro/copilot-account.json}.

     *

     * @return {@code ~/.spectro/copilot-account.json}

     */
    public static Path defaultPath() {
        return Path.of(System.getProperty("user.home"), ".spectro", "copilot-account.json");
    }

    /**

     * Returns the file.

     *

     * @return the file

     */
    public Path path() {
        return file;
    }

    /**
     * Reads the stored sign-in.
     *
     * @return the stored sign-in, or empty when there is none or the file is not one
     * @throws IOException when the file exists and cannot be read
     */
    public synchronized Optional<Stored> load() throws IOException {
        String text;
        try {
            text = Files.readString(file, StandardCharsets.UTF_8);
        } catch (NoSuchFileException absent) {
            return Optional.empty();
        }
        JsonNode node;
        try {
            node = JSON.readTree(text);
        } catch (IOException notJson) {
            return Optional.empty();
        }
        Method method;
        try {
            method = Method.valueOf(node.path("method").asText(""));
        } catch (IllegalArgumentException unknown) {
            return Optional.empty();
        }
        return Optional.of(new Stored(method, node.path("login").asText(null), node.path("accessToken").asText(null),
                node.path("accessExpiresAt").asLong(0), node.path("refreshToken").asText(null),
                node.path("refreshExpiresAt").asLong(0)));
    }

    /**
     * Replaces whatever was stored.
     *
     * @param stored the sign-in
     * @throws IOException when the file cannot be written
     */
    public synchronized void save(Stored stored) throws IOException {
        ObjectNode node = JSON.createObjectNode();
        node.put("method", stored.method().name());
        node.put("login", stored.login());
        node.put("accessToken", stored.accessToken());
        node.put("accessExpiresAt", stored.accessExpiresAt());
        node.put("refreshToken", stored.refreshToken());
        node.put("refreshExpiresAt", stored.refreshExpiresAt());
        byte[] bytes = JSON.writerWithDefaultPrettyPrinter().writeValueAsBytes(node);

        Path dir = file.toAbsolutePath().getParent();
        Files.createDirectories(dir);
        Path temp = dir.resolve("." + file.getFileName() + "." + UUID.randomUUID() + ".tmp");
        try {
            try {
                Files.createFile(temp, PosixFilePermissions.asFileAttribute(PosixFilePermissions.fromString("rw-------")));
            } catch (UnsupportedOperationException nonPosix) {
                Files.createFile(temp);
            } catch (FileAlreadyExistsException clash) {
                throw new IOException("a temporary file of the same name exists", clash);
            }
            Files.write(temp, bytes);
            try {
                Files.move(temp, file, StandardCopyOption.ATOMIC_MOVE, StandardCopyOption.REPLACE_EXISTING);
            } catch (AtomicMoveNotSupportedException noAtomic) {
                Files.move(temp, file, StandardCopyOption.REPLACE_EXISTING);
            }
        } finally {
            Files.deleteIfExists(temp);
        }
        try {
            Files.setPosixFilePermissions(file, PosixFilePermissions.fromString("rw-------"));
        } catch (UnsupportedOperationException nonPosix) {
            // Not POSIX: the file stays under the user's home, as the key file does.
        }
    }

    /**
     * Deletes the stored sign-in.
     *
     * @return true when a file was deleted
     * @throws IOException when it cannot be deleted
     */
    public synchronized boolean delete() throws IOException {
        return Files.deleteIfExists(file);
    }
}
