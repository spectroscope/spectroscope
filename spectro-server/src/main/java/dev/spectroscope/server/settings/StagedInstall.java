package dev.spectroscope.server.settings;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import java.io.IOException;
import java.io.InputStream;
import java.nio.file.DirectoryNotEmptyException;
import java.nio.file.FileAlreadyExistsException;
import java.nio.file.Files;
import java.nio.file.LinkOption;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import java.util.Comparator;
import java.util.List;
import java.util.stream.Stream;

/**
 * The staging steps of an install, taken out of the catalogue install (card 182)
 * so the playbook installer (card 485) uses the same ones: write every file into
 * a folder beside the target root, move that folder into place with one atomic
 * move, and clear what is left.
 *
 * <p>The staging root must sit outside the root the target lives in. A half
 * built skill folder already carries a SKILL.md, so a loader reading the root
 * while the copy is written would pick it up.</p>
 *
 * <p>Files are written byte for byte from their source streams. No permission
 * is copied, so nothing staged here is executable, and nothing is a symlink.</p>
 */
public final class StagedInstall {

    private static final Logger log = LoggerFactory.getLogger(StagedInstall.class);

    private StagedInstall() {
    }

    /** Where the bytes of one file come from. */
    @FunctionalInterface
    public interface Source {
        /**
         * Opens the bytes to write.
         *
         * @return a fresh stream, closed by the caller
         * @throws IOException when the source cannot be read
         */
        InputStream open() throws IOException;
    }

    /**
     * One file of an install.
     *
     * @param rel    the path below the staged folder, with {@code /} as separator
     * @param source where its bytes come from
     */
    public record FileCopy(String rel, Source source) {
    }

    /** How one file lands at its destination inside the staged folder. */
    @FunctionalInterface
    public interface Copier {
        /**
         * Writes one file.
         *
         * @param file        the file to write
         * @param destination its path inside the staged folder, parent already created
         * @throws IOException when the read or the write fails
         */
        void copy(FileCopy file, Path destination) throws IOException;
    }

    /** The plain copier: the source's bytes, replacing a file of the same name. */
    public static final Copier STREAM = (file, destination) -> {
        try (InputStream in = file.source().open()) {
            Files.copy(in, destination, StandardCopyOption.REPLACE_EXISTING);
        }
    };

    /** How a promote ended. */
    public enum Outcome {
        /** The staged folder is now the target. */
        MOVED,
        /** The target already existed; nothing moved and the staged folder is still there. */
        TAKEN
    }

    /** A relative path that would write outside the staged folder. Nothing outside was written. */
    public static final class OutsideFolder extends IOException {

        /** The serial form version. */
        private static final long serialVersionUID = 1L;

        /** The refused relative path. */
        private final String rel;

        OutsideFolder(String rel) {
            super("A file would land outside the staged folder: " + rel);
            this.rel = rel;
        }

        /**
         * The relative path as the caller gave it.
         *
         * @return the refused path
         */
        public String rel() {
            return rel;
        }
    }

    /**
     * Creates {@code stagingRoot/<label>-<nanoTime>} and writes every file into
     * it with {@link #STREAM}.
     *
     * @param stagingRoot where staged folders wait, outside the target root
     * @param label       the first part of the staged folder's name
     * @param files       the files, written in this order
     * @return the staged folder
     * @throws OutsideFolder when a relative path leaves the folder; nothing is left behind
     * @throws IOException   when a file cannot be written; nothing is left behind
     */
    public static Path build(Path stagingRoot, String label, List<FileCopy> files) throws IOException {
        return build(stagingRoot, label, files, STREAM);
    }

    /**
     * Creates {@code stagingRoot/<label>-<nanoTime>} and writes every file into
     * it through the given copier, the seam the catalogue keeps for its failed
     * copy test.
     *
     * @param stagingRoot where staged folders wait, outside the target root
     * @param label       the first part of the staged folder's name
     * @param files       the files, written in this order
     * @param copier      how each file is written
     * @return the staged folder
     * @throws OutsideFolder when a relative path leaves the folder; nothing is left behind
     * @throws IOException   when a file cannot be written; nothing is left behind
     */
    public static Path build(Path stagingRoot, String label, List<FileCopy> files, Copier copier)
            throws IOException {
        Path staged = stagingRoot.resolve(label + "-" + System.nanoTime());
        boolean built = false;
        try {
            Files.createDirectories(staged);
            for (FileCopy file : files) {
                Path destination = staged.resolve(file.rel()).normalize();
                if (!destination.startsWith(staged)) {
                    throw new OutsideFolder(file.rel());
                }
                Files.createDirectories(destination.getParent());
                copier.copy(file, destination);
            }
            built = true;
            return staged;
        } finally {
            if (!built) {
                discard(staged, stagingRoot);
            }
        }
    }

    /**
     * Moves the staged folder onto the target with one atomic move, creating the
     * target's parent first. A target that exists, empty or not, is
     * {@link Outcome#TAKEN} and stays as it was.
     *
     * @param staged the folder {@link #build} returned
     * @param target where it should end up
     * @return {@link Outcome#MOVED}, or {@link Outcome#TAKEN} with the staged folder untouched
     * @throws IOException when the move fails for another reason
     */
    public static Outcome promote(Path staged, Path target) throws IOException {
        // Checked first because an atomic rename onto an EMPTY folder replaces it
        // without an error, and onto a non empty one fails with a plain
        // FileSystemException, not DirectoryNotEmptyException (measured on
        // macOS with JDK 21.0.12, 2026-10-09).
        if (Files.exists(target, LinkOption.NOFOLLOW_LINKS)) {
            return Outcome.TAKEN;
        }
        Files.createDirectories(target.getParent());
        try {
            Files.move(staged, target, StandardCopyOption.ATOMIC_MOVE);
            return Outcome.MOVED;
        } catch (FileAlreadyExistsException | DirectoryNotEmptyException taken) {
            // The race behind the look above: somebody created the target between
            // the look and the move.
            return Outcome.TAKEN;
        }
    }

    /**
     * Deletes the staged tree, then the staging root when that left it empty.
     * Never throws.
     *
     * @param staged      the staged folder, absent or null when there is none
     * @param stagingRoot the staging root, kept when another install still waits in it
     */
    public static void discard(Path staged, Path stagingRoot) {
        if (staged != null) {
            deleteTree(staged);
        }
        deleteIfEmpty(stagingRoot);
    }

    private static void deleteTree(Path root) {
        if (!Files.exists(root)) {
            return;
        }
        try (Stream<Path> walk = Files.walk(root)) {
            for (Path path : walk.sorted(Comparator.reverseOrder()).toList()) {
                Files.deleteIfExists(path);
            }
        } catch (IOException stubborn) {
            log.warn("could not clear the staging directory {} ({})", root, stubborn.toString());
        }
    }

    private static void deleteIfEmpty(Path dir) {
        try (Stream<Path> entries = Files.list(dir)) {
            if (entries.findAny().isEmpty()) {
                Files.deleteIfExists(dir);
            }
        } catch (IOException absentOrBusy) {
            // an absent or non-empty staging root is fine; another install may own it
        }
    }
}
