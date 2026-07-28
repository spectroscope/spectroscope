package dev.spectroscope.cli;

import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.Timeout;
import org.junit.jupiter.api.io.TempDir;

import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.LinkedBlockingQueue;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicReference;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * The fs trigger around its {@link DirWatch} seam. All debounce logic is
 * pinned in {@link FsDebouncerTest} against injected clocks; here the fake
 * seam proves the thread wiring (poll → debounce → fire), and ONE real-
 * filesystem smoke test covers the WatchService binding — macOS's
 * WatchService is a ~2 s poller, hence the generous timeout on that one.
 */
class FsWatchTriggerTest {

    /** The card's fake watch seam: poll() hands out whatever the test queued. */
    private static final class FakeDirWatch implements DirWatch {
        final LinkedBlockingQueue<List<FsDebouncer.Change>> batches = new LinkedBlockingQueue<>();

        @Override
        public List<FsDebouncer.Change> poll(long timeoutMs) throws InterruptedException {
            List<FsDebouncer.Change> batch = batches.poll(timeoutMs, TimeUnit.MILLISECONDS);
            return batch == null ? List.of() : batch;
        }

        @Override
        public void close() {
        }
    }

    @Test
    @Timeout(value = 15, unit = TimeUnit.SECONDS)
    void changesFromTheSeamBecomeOneDebouncedFire(@TempDir Path root) throws Exception {
        FakeDirWatch fake = new FakeDirWatch();
        AtomicReference<Fire> seen = new AtomicReference<>();
        CountDownLatch fired = new CountDownLatch(1);
        try (FsWatchTrigger trigger = new FsWatchTrigger(root, fake,
                System::currentTimeMillis, line -> { })) {
            assertEquals("watch:" + root, trigger.describe());
            trigger.start(fire -> {
                seen.set(fire);
                fired.countDown();
                return FireSlot.Disposition.ACCEPTED;
            });

            fake.batches.add(List.of(new FsDebouncer.Change("created", "a.txt", false)));
            fake.batches.add(List.of(new FsDebouncer.Change("modified", "b.txt", false)));

            assertTrue(fired.await(10, TimeUnit.SECONDS), "the debounced fire arrives");
            assertEquals("fs", seen.get().kind());
            assertTrue(seen.get().entries().contains("created a.txt"), seen.get().entries().toString());
            assertTrue(seen.get().entries().contains("modified b.txt"),
                    "both changes rode the SAME quiet window into one fire");
        }
    }

    @Test
    @Timeout(value = 20, unit = TimeUnit.SECONDS)
    void aRealFileLandingInTheWatchedDirectoryFires(@TempDir Path root) throws Exception {
        // The one real-filesystem smoke test: WatchService on macOS polls
        // (~2 s), so this pins only the binding, never timing details.
        AtomicReference<Fire> seen = new AtomicReference<>();
        CountDownLatch fired = new CountDownLatch(1);
        try (FsWatchTrigger trigger = new FsWatchTrigger(root, new WatchServiceDirWatch(root),
                System::currentTimeMillis, line -> { })) {
            trigger.start(fire -> {
                seen.set(fire);
                fired.countDown();
                return FireSlot.Disposition.ACCEPTED;
            });

            Thread.sleep(300); // the watcher must be registered before the change lands
            Files.writeString(root.resolve("smoke.txt"), "hello");

            assertTrue(fired.await(15, TimeUnit.SECONDS), "the real watcher saw the file");
            assertTrue(seen.get().entries().stream().anyMatch(entry -> entry.contains("smoke.txt")),
                    seen.get().entries().toString());
        }
    }
}
