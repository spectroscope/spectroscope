package dev.spectroscope.core.wire;

import dev.spectroscope.core.events.RunEvent;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.LinkOption;
import java.nio.file.Path;
import java.util.List;

/**
 * Which {@code run_start} of a session names the files beside it, and what it
 * names (card 473). One rule for every writer: the server's session, the
 * headless runner and the CLI each stamp the main agent's {@code run_start}
 * through this class before the line reaches the file.
 *
 * <p>The first main {@code run_start} this writer sees carries the
 * reference: the llm wire when the writer records one, an empty child list,
 * and the browser wire only when that file was already written. A browser
 * wire that appears later is named on the next main {@code run_start}. Every
 * other line passes unchanged, so the file gains no line and the trace no
 * row. A session resumed in a later process is stamped once more on its first
 * run there; a reader takes the union of the references it finds.</p>
 */
public final class WireReference {

    private final String sessionId;
    private final boolean recordsLlmWire;
    /** Guarded by this. */
    private boolean stamped;
    /** Guarded by this. */
    private boolean browserNamed;

    /**
     * A reference for one session, before its first run_start.
     *
     * @param sessionId      the session the files belong to, a plain basename
     * @param recordsLlmWire whether this writer records the session's llm wire
     * @throws IllegalArgumentException when the id is not a plain basename
     */
    public WireReference(String sessionId, boolean recordsLlmWire) {
        LlmWireRecorder.fileFor(sessionId); // the one shape check, before any line
        this.sessionId = sessionId;
        this.recordsLlmWire = recordsLlmWire;
    }

    /**
     * The event as it goes to the file: a main {@code run_start} with the
     * reference when it has something new to say, every other event as it is.
     *
     * @param event the next event of the session
     * @return the stamped copy, or the same event
     */
    public synchronized RunEvent stamp(RunEvent event) {
        if (!(event instanceof RunEvent.RunStart start) || start.parentId() != null) {
            return event;
        }
        Path browser = BrowserWireRecorder.fileFor(sessionId);
        boolean browserWritten = written(browser);
        if (stamped && (browserNamed || !browserWritten)) {
            return event;
        }
        stamped = true;
        browserNamed = browserWritten;
        String llm = recordsLlmWire ? LlmWireRecorder.fileFor(sessionId).getFileName().toString() : null;
        return start.withWires(llm, browserWritten ? browser.getFileName().toString() : null, List.of());
    }

    private static boolean written(Path file) {
        try {
            return Files.isRegularFile(file, LinkOption.NOFOLLOW_LINKS) && Files.size(file) > 0;
        } catch (IOException unreadable) {
            return false;
        }
    }
}
