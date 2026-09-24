package dev.spectroscope.server;

import java.util.Optional;
import java.util.function.Consumer;

/**
 * Card 396: a server started with {@code -Dspectro.bundle.bin} ends when its
 * parent process ends.
 *
 * <p>The desktop sends this JVM a SIGTERM from {@code before-quit}. A SIGKILL
 * to the Electron main process skips that, and on 2026-09-23 two servers kept
 * running with parent PID 1 and kept their ports until someone found them by
 * hand. The packaged desktop app passes {@code -Dspectro.bundle.bin} when its
 * package carries the bundled binaries ({@code spectro-desktop/src/main.ts},
 * spawnServer), and no other launcher passes it, so that property is the sign
 * to watch: a server started from a terminal, a script or {@code nohup} is
 * left alone.</p>
 *
 * <p>The parent is not this JVM's child, so the JDK notices its end by
 * polling: every 300 ms at first, 30 ms slower each round, at most every
 * 5 s ({@code ProcessHandleImpl.completion}, JDK 21.0.12 and 26.0.2.1).</p>
 */
final class ParentWatch {

    private ParentWatch() {
    }

    /**
     * Watches this JVM's parent when the desktop app started it.
     *
     * @param bundleBin the value of {@code spectro.bundle.bin}, null when it is not set
     * @param onGone    what runs, on its own thread, once the parent has ended
     * @return the watched parent, empty when nothing is watched
     */
    static Optional<ProcessHandle> install(String bundleBin, Consumer<ProcessHandle> onGone) {
        if (bundleBin == null) {
            return Optional.empty();
        }
        Optional<ProcessHandle> parent = ProcessHandle.current().parent();
        parent.ifPresent(watched -> watched.onExit().thenAccept(gone ->
                Thread.ofPlatform().name("parent-watch").start(() -> onGone.accept(gone))));
        return parent;
    }
}
