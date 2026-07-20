package dev.spectroscope.mcp.notes;

import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;
import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

class NotesStoreTest {

    @Test
    void addThenListRoundTrips(@TempDir Path dir) {
        NotesStore store = new NotesStore(dir);
        store.add("first note about foxes");
        store.add("second note about dogs");

        List<NotesStore.Note> notes = store.list();
        assertEquals(2, notes.size());
        List<String> texts = notes.stream().map(NotesStore.Note::text).toList();
        assertTrue(texts.contains("first note about foxes"));
        assertTrue(texts.contains("second note about dogs"));
    }

    @Test
    void oneFilePerNote(@TempDir Path dir) throws Exception {
        NotesStore store = new NotesStore(dir);
        store.add("alpha");
        store.add("beta");
        store.add("gamma");

        long fileCount = Files.list(dir).filter(Files::isRegularFile).count();
        assertEquals(3, fileCount);
    }

    @Test
    void addReturnsDistinctCollisionFreeNamesEvenForIdenticalText(@TempDir Path dir) {
        NotesStore store = new NotesStore(dir);
        String a = store.add("same text");
        String b = store.add("same text");
        assertNotEquals(a, b);
        assertEquals(2, store.list().size());
    }

    /**
     * Regression for the collision finding: two identical texts racing the
     * directory scan compute the same index AND the same content hash, so the old
     * name derivation produced identical file names and silently overwrote — the
     * write side used {@code Files.writeString}, which happily clobbers. With
     * atomic {@code createFile} + retry, N identical concurrent adds must yield N
     * distinct files and N entries.
     */
    @Test
    void concurrentIdenticalAddsNeverOverwriteEachOther(@TempDir Path dir) throws Exception {
        NotesStore store = new NotesStore(dir);
        int writers = 16;
        CountDownLatch startGate = new CountDownLatch(1);
        CountDownLatch done = new CountDownLatch(writers);
        Set<String> names = ConcurrentHashMap.newKeySet();

        for (int i = 0; i < writers; i++) {
            Thread t = new Thread(() -> {
                try {
                    startGate.await();            // all writers pounce at once → maximize the race
                    names.add(store.add("identical note"));
                } catch (InterruptedException e) {
                    Thread.currentThread().interrupt();
                } finally {
                    done.countDown();
                }
            });
            t.setDaemon(true);
            t.start();
        }
        startGate.countDown();
        assertTrue(done.await(30, TimeUnit.SECONDS), "writers did not finish in time");

        assertEquals(writers, names.size(), "every add() must return a unique file name");
        long fileCount = Files.list(dir).filter(Files::isRegularFile).count();
        assertEquals(writers, fileCount, "no note file may be overwritten by an identical one");
        assertEquals(writers, store.list().size());
    }

    @Test
    void missingDirectoryListsAsEmpty(@TempDir Path dir) {
        NotesStore store = new NotesStore(dir.resolve("does-not-exist"));
        assertTrue(store.list().isEmpty());
    }

    @Test
    void listIsStableByFileName(@TempDir Path dir) {
        NotesStore store = new NotesStore(dir);
        store.add("one");
        store.add("two");
        List<NotesStore.Note> first = store.list();
        List<NotesStore.Note> second = store.list();
        assertEquals(first.stream().map(NotesStore.Note::file).toList(),
                second.stream().map(NotesStore.Note::file).toList());
    }
}
