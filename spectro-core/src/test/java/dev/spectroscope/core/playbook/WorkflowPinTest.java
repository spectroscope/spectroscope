package dev.spectroscope.core.playbook;

import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Map;
import java.util.concurrent.atomic.AtomicInteger;

import static org.junit.jupiter.api.Assertions.assertArrayEquals;
import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * Card 506, fix round 1: a workflow starts on the bytes that hashed to the
 * confirmed hash. The file is read once; the hash and the parse see the same
 * buffer, so a swap after the check cannot start other bytes.
 */
class WorkflowPinTest {

    private static final byte[] LISTED = "{ \"name\": \"listed\" }".getBytes(StandardCharsets.UTF_8);
    private static final byte[] SWAPPED = "{ \"name\": \"swapped\" }".getBytes(StandardCharsets.UTF_8);

    private static Path folder(Path tmp) throws IOException {
        Path folder = Files.createDirectories(tmp.resolve("pb")).toRealPath();
        Files.createDirectories(folder.resolve("workflows"));
        Files.write(folder.resolve("workflows/a.json"), LISTED);
        return folder;
    }

    private static String listedHash() {
        return ContentHash.entries(Map.of("a.json", LISTED));
    }

    @Test
    void theListedBytesArePinnedWhenTheyHashToTheConfirmedHash(@TempDir Path tmp) throws IOException {
        Path folder = folder(tmp);
        WorkflowPin.Pinned pinned = WorkflowPin.pin(folder, folder.resolve("workflows/a.json"), listedHash());
        assertFalse(pinned.changed());
        assertArrayEquals(LISTED, pinned.bytes());
    }

    @Test
    void bytesThatChangedAfterTheCheckAreNeverHandedOutUnderTheConfirmedHash(@TempDir Path tmp) throws IOException {
        // The reader stands for the file as it is at the moment of the read: the
        // listed bytes are on disk, the swap has already happened for every read.
        Path folder = folder(tmp);
        AtomicInteger reads = new AtomicInteger();
        WorkflowPin.Pinned pinned = WorkflowPin.pin(folder, folder.resolve("workflows/a.json"), listedHash(),
                file -> {
                    reads.incrementAndGet();
                    return SWAPPED;
                });
        assertTrue(pinned.changed(), "other bytes than the confirmed ones are a changed file");
        assertNull(pinned.bytes());
        assertEquals(1, reads.get(), "one read: the hash and the parse see the same buffer");
    }

    @Test
    void aWrongHashIsAChangedFile(@TempDir Path tmp) throws IOException {
        Path folder = folder(tmp);
        WorkflowPin.Pinned pinned = WorkflowPin.pin(folder, folder.resolve("workflows/a.json"), "00");
        assertTrue(pinned.changed());
        assertNull(pinned.bytes());
    }

    @Test
    void aLinkInPlaceOfTheFileIsAChangedFile(@TempDir Path tmp) throws IOException {
        Path folder = folder(tmp);
        Path outside = Files.write(tmp.resolve("outside.json"), LISTED);
        Files.delete(folder.resolve("workflows/a.json"));
        Files.createSymbolicLink(folder.resolve("workflows/a.json"), outside);
        WorkflowPin.Pinned pinned = WorkflowPin.pin(folder, folder.resolve("workflows/a.json"), listedHash());
        assertTrue(pinned.changed());
        assertNull(pinned.bytes());
    }

    // ---- Fix round 2: each check on its own --------------------------------------------------

    @Test
    void anEmptyDirectoryInPlaceOfTheFileIsAChangedFileAndNotAnError(@TempDir Path tmp) throws IOException {
        // The walk of an empty directory lists no file: the count check refuses it
        // before the first entry is read.
        Path folder = folder(tmp);
        Files.delete(folder.resolve("workflows/a.json"));
        Files.createDirectories(folder.resolve("workflows/a.json"));
        WorkflowPin.Pinned pinned = WorkflowPin.pin(folder, folder.resolve("workflows/a.json"), listedHash(),
                file -> LISTED);
        assertTrue(pinned.changed());
        assertNull(pinned.bytes());
    }

    @Test
    void aDirectoryHoldingOneFileOfTheListedNameIsAChangedFile(@TempDir Path tmp) throws IOException {
        // The walk of a directory lists the one file inside it, under the listed
        // name; only the path check tells that file from the target. The reader
        // hands out the listed bytes for any path, so nothing else refuses it.
        Path folder = folder(tmp);
        Files.delete(folder.resolve("workflows/a.json"));
        Files.createDirectories(folder.resolve("workflows/a.json"));
        Files.write(folder.resolve("workflows/a.json/a.json"), LISTED);
        AtomicInteger reads = new AtomicInteger();
        WorkflowPin.Pinned pinned = WorkflowPin.pin(folder, folder.resolve("workflows/a.json"), listedHash(),
                file -> {
                    reads.incrementAndGet();
                    return LISTED;
                });
        assertTrue(pinned.changed());
        assertNull(pinned.bytes());
        assertEquals(0, reads.get(), "nothing is read for a target that is not a file");
    }

    @Test
    void aFileReachedThroughALinkedParentThatLeavesTheFolderIsAChangedFile(@TempDir Path tmp) throws IOException {
        Path folder = folder(tmp);
        Path outside = Files.createDirectories(tmp.resolve("outside"));
        Files.write(outside.resolve("a.json"), LISTED);
        Files.createSymbolicLink(folder.resolve("linked"), outside);
        WorkflowPin.Pinned pinned = WorkflowPin.pin(folder, folder.resolve("linked/a.json"), listedHash(),
                file -> LISTED);
        assertTrue(pinned.changed());
        assertNull(pinned.bytes());
    }

    /** Card 554: a workflow started by name runs on the bytes of one read, recorded with their hash. */
    @Test
    void aWorkflowStartedByNameIsReadOnceWithTheHashTheModuleLists(@TempDir Path tmp) throws IOException {
        Path folder = folder(tmp);
        WorkflowPin.Current current = WorkflowPin.current(folder, folder.resolve("workflows/a.json"));
        assertArrayEquals(LISTED, current.bytes());
        assertEquals(listedHash(), current.hash());
    }

    @Test
    void aLinkIsNotReadByName(@TempDir Path tmp) throws IOException {
        Path folder = folder(tmp);
        Path outside = Files.write(tmp.resolve("outside.json"), LISTED);
        Files.delete(folder.resolve("workflows/a.json"));
        Files.createSymbolicLink(folder.resolve("workflows/a.json"), outside);
        assertNull(WorkflowPin.current(folder, folder.resolve("workflows/a.json")));
        assertNull(WorkflowPin.current(folder, folder.resolve("workflows")), "a folder is not a workflow");
    }
}
