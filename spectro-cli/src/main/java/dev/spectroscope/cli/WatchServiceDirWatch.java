package dev.spectroscope.cli;

import java.io.IOException;
import java.nio.file.Path;
import java.nio.file.StandardWatchEventKinds;
import java.nio.file.WatchEvent;
import java.nio.file.WatchKey;
import java.nio.file.WatchService;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.TimeUnit;

/**
 * The real {@link DirWatch}: a java.nio WatchService on ONE directory,
 * non-recursive — the documented v1 limit of the fs trigger. WatchService
 * contexts are names relative to the registered directory, which is exactly
 * the shape the debouncer's fence expects.
 */
final class WatchServiceDirWatch implements DirWatch {

    private final WatchService service;

    WatchServiceDirWatch(Path root) throws IOException {
        this.service = root.getFileSystem().newWatchService();
        root.register(service, StandardWatchEventKinds.ENTRY_CREATE,
                StandardWatchEventKinds.ENTRY_MODIFY, StandardWatchEventKinds.ENTRY_DELETE);
    }

    @Override
    public List<FsDebouncer.Change> poll(long timeoutMs) throws InterruptedException {
        WatchKey key = service.poll(timeoutMs, TimeUnit.MILLISECONDS);
        if (key == null) {
            return List.of();
        }
        List<FsDebouncer.Change> changes = new ArrayList<>();
        for (WatchEvent<?> event : key.pollEvents()) {
            if (event.kind() == StandardWatchEventKinds.OVERFLOW) {
                changes.add(FsDebouncer.Change.overflowed());
                continue;
            }
            String verb = event.kind() == StandardWatchEventKinds.ENTRY_CREATE ? "created"
                    : event.kind() == StandardWatchEventKinds.ENTRY_MODIFY ? "modified"
                    : "deleted";
            changes.add(new FsDebouncer.Change(verb, event.context().toString(), false));
        }
        key.reset();
        return changes;
    }

    @Override
    public void close() {
        try {
            service.close();
        } catch (IOException ignored) {
            // a watch that cannot close is already useless — nothing to salvage
        }
    }
}
