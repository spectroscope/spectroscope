package dev.spectroscope.core.leveling;

import com.fasterxml.jackson.databind.ObjectMapper;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.AtomicMoveNotSupportedException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import java.nio.file.attribute.PosixFilePermissions;
import java.util.Objects;
import java.util.Optional;

/**
 * The one file the wave writes: {@code ~/.spectro/leveling.json}, holding this
 * home's mode, marks and history.
 *
 * <p>House discipline for home files applies. Writes go through a temp file in
 * the same directory and an atomic move, so a crash mid-write leaves the old
 * state rather than half of the new one. The file is owner-only, like
 * {@code .env}: it records what a person did with their own tool.</p>
 *
 * <p>Reads never throw. A missing file is a home that has not started, and an
 * unreadable one is treated the same way with a warning, because the ladder is
 * a nicety and no nicety is worth an exception on somebody's first morning.
 * The caller decides what a fresh state should look like; this class only
 * reports that there is nothing usable on disk.</p>
 *
 * <p>Single writer by discipline, not by lock: in a running system only the
 * server writes this file. The methods are synchronized so that the server's
 * own threads cannot interleave.</p>
 */
public final class LevelingStore {

    /** Where the state lives for the current user. */
    public static final Path DEFAULT_FILE =
            Path.of(System.getProperty("user.home"), ".spectro", "leveling.json");

    private static final ObjectMapper JSON = new ObjectMapper();

    private final Path file;

    /**
     * @param file the state file, which need not exist yet
     */
    public LevelingStore(Path file) {
        this.file = Objects.requireNonNull(file, "file");
    }

    /** @return a store over the current user's {@code ~/.spectro/leveling.json} */
    public static LevelingStore userStore() {
        return new LevelingStore(DEFAULT_FILE);
    }

    /** @return the file this store reads and writes */
    public Path file() {
        return file;
    }

    /**
     * Reads the stored state.
     *
     * @return the state, or empty when the file is absent or unreadable — never an exception
     */
    public synchronized Optional<LevelingState> read() {
        if (!Files.isRegularFile(file)) {
            return Optional.empty();
        }
        try {
            String text = Files.readString(file, StandardCharsets.UTF_8);
            return Optional.ofNullable(JSON.readValue(text, LevelingState.class));
        } catch (IOException | RuntimeException unreadable) {
            System.err.println("leveling: " + file + " is unreadable, starting over ("
                    + unreadable.getClass().getSimpleName() + ")");
            return Optional.empty();
        }
    }

    /**
     * Writes the state atomically.
     *
     * @param state the state to persist
     * @throws IOException when the directory cannot be created or the file cannot be replaced
     */
    public synchronized void write(LevelingState state) throws IOException {
        Objects.requireNonNull(state, "state");
        Path dir = file.toAbsolutePath().getParent();
        Files.createDirectories(dir);
        Path temp = Files.createTempFile(dir, "." + file.getFileName() + ".", ".tmp");
        try {
            Files.writeString(temp, JSON.writerWithDefaultPrettyPrinter().writeValueAsString(state) + "\n",
                    StandardCharsets.UTF_8);
            ownerOnly(temp);
            try {
                Files.move(temp, file, StandardCopyOption.REPLACE_EXISTING, StandardCopyOption.ATOMIC_MOVE);
            } catch (AtomicMoveNotSupportedException noAtomicMove) {
                Files.move(temp, file, StandardCopyOption.REPLACE_EXISTING);
            }
        } finally {
            Files.deleteIfExists(temp);
        }
    }

    /** Best effort, exactly like the .env key writer: a permissionless filesystem is not fatal. */
    private static void ownerOnly(Path path) {
        try {
            Files.setPosixFilePermissions(path, PosixFilePermissions.fromString("rw-------"));
        } catch (IOException | UnsupportedOperationException notPosix) {
            // Windows and exotic filesystems: the content is not a secret, only private.
        }
    }
}
