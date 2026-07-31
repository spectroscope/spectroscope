package dev.spectroscope.cli;

import java.util.List;

/**
 * The fs trigger's seam over the platform watcher (card 72): one blocking
 * poll, plain data out. The real implementation is {@link WatchServiceDirWatch};
 * tests drive {@link FsWatchTrigger} through a fake, because macOS's
 * WatchService is a ~2 s poller and every debounce case would otherwise cost
 * seconds of wall-clock waiting.
 */
interface DirWatch extends AutoCloseable {

    /**
     * Waits up to {@code timeoutMs} for the next batch of changes.
     *
     * @param timeoutMs how long to park at most
     * @return the polled changes; empty on timeout
     * @throws InterruptedException on thread interrupt while parked
     */
    List<FsDebouncer.Change> poll(long timeoutMs) throws InterruptedException;

    /** Narrowed: closing the watch never throws — shutdown must not fail. */
    @Override
    void close();
}
