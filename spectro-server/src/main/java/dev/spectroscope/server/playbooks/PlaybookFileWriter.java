package dev.spectroscope.server.playbooks;

import dev.spectroscope.core.config.SpectroConfig;
import dev.spectroscope.core.playbook.Finding;
import dev.spectroscope.core.playbook.PlaybookWriter;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import java.nio.file.attribute.PosixFileAttributeView;
import java.nio.file.attribute.PosixFilePermission;
import java.util.List;
import java.util.Set;

/**
 * Saves the editor's draft as the {@code playbook.json} of a registered folder.
 *
 * <p>The draft is validated first, as a load validates a file. The hash of the
 * bytes on disk must equal the hash the draft was made from, so a change made
 * outside the editor is never overwritten silently. The file is replaced
 * through a temp file in the same folder and an atomic move, with the old
 * file's permissions. Nothing is written unless the answer is {@link Written}.
 */
public final class PlaybookFileWriter {

    /** The three answers of a save. */
    public sealed interface Result permits Written, Refused, Changed {}

    /** The file was replaced; {@code view} is the editor view of what is on disk now. */
    public record Written(EditorView view) implements Result {}

    /** The draft has findings, or did not parse; nothing was written. */
    public record Refused(List<Finding> findings) implements Result {}

    /** The file on disk is not the one the draft was made from; nothing was written. */
    public record Changed(String diskHash) implements Result {}

    private PlaybookFileWriter() {
    }

    /**
     * Validates the draft, compares the base hash, writes the canonical form atomically.
     * Nothing is written unless the answer is {@link Written}.
     *
     * @throws IllegalArgumentException when {@code playbook.json} is a symbolic link
     * @throws IOException              when the folder or file cannot be read or written
     */
    public static synchronized Result save(Path dir, String baseHash, String draftJson, Path workspace,
            SpectroConfig config) throws IOException {
        Path root = dir.toRealPath();
        Path target = root.resolve(PlaybookFolders.PLAYBOOK_FILE);
        if (Files.isSymbolicLink(target)) {
            throw new IllegalArgumentException("playbook.json is a symbolic link; it is not written through");
        }
        byte[] disk = Files.isRegularFile(target) ? Files.readAllBytes(target) : new byte[0];
        String diskHash = EditorView.sha256(disk);
        if (!diskHash.equals(baseHash)) {
            return new Changed(diskHash);
        }
        PlaybookLoader.Loaded loaded = PlaybookLoader.fromJson(root, draftJson, workspace, config);
        if (loaded.playbook() == null || !loaded.findings().isEmpty()) {
            return new Refused(loaded.findings());
        }
        byte[] written = PlaybookWriter.write(loaded.playbook()).getBytes(StandardCharsets.UTF_8);
        writeAtomically(target, written);
        return new Written(EditorView.of(root, new String(written, StandardCharsets.UTF_8), written, workspace,
                config));
    }

    private static void writeAtomically(Path target, byte[] content) throws IOException {
        Path folder = target.getParent();
        Path temp = Files.createTempFile(folder, "." + target.getFileName() + ".", ".tmp");
        try {
            Files.write(temp, content);
            copyPermissions(target, temp);
            Files.move(temp, target, StandardCopyOption.ATOMIC_MOVE, StandardCopyOption.REPLACE_EXISTING);
        } catch (IOException | RuntimeException failure) {
            Files.deleteIfExists(temp);
            throw failure;
        }
    }

    /** Gives the temp file the mode of the file it replaces, where the file system has a POSIX view. */
    private static void copyPermissions(Path from, Path to) throws IOException {
        if (!Files.exists(from)) {
            return;
        }
        PosixFileAttributeView view = Files.getFileAttributeView(from, PosixFileAttributeView.class);
        if (view == null) {
            return;
        }
        Set<PosixFilePermission> permissions = view.readAttributes().permissions();
        Files.setPosixFilePermissions(to, permissions);
    }
}
