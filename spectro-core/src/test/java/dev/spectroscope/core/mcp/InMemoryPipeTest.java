package dev.spectroscope.core.mcp;

import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.Timeout;

import java.io.IOException;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.TimeUnit;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNull;

/**
 * Pins the one property the MCP pipe tests need from {@link InMemoryPipe}: a line
 * still arrives after the thread that wrote the previous line has ended. That is
 * the shape of every {@code tools/call} through {@link McpClient}, which writes
 * from a virtual thread that ends with the call.
 *
 * <p>{@code PipedReader} breaks this in two ways, and each test below pins one.
 * A reader that arrives after the last writer ended fails at once with "Write end
 * dead". A reader that was already waiting fails with "Pipe broken" once the
 * writer is dead and three one-second waits have passed (JDK 21
 * {@code PipedReader.read}). Swapping the helper back to {@code PipedReader} and
 * {@code PipedWriter} turns both tests red.
 */
@Timeout(value = 30, unit = TimeUnit.SECONDS, threadMode = Timeout.ThreadMode.SEPARATE_THREAD)
class InMemoryPipeTest {

    /** Longer than the three one-second waits a parked {@code PipedReader} allows a dead writer. */
    private static final long PAST_THE_PIPED_WINDOW_MS = 3_500;

    /** How long the first writer outlives its line, so the reader parks before it ends. */
    private static final long WRITER_LINGERS_MS = 300;

    @Test
    void aReaderArrivingAfterTheLastWriterEndedStillGetsTheNextLine() throws Exception {
        InMemoryPipe pipe = InMemoryPipe.open();
        writeFromAThreadThatEnds(pipe, "first");
        assertEquals("first", pipe.reader().readLine());

        // The last writer is dead and the buffer is empty when this read starts.
        CompletableFuture<Void> later = CompletableFuture.runAsync(() -> {
            sleep(200);
            writeLine(pipe, "second");
        });
        assertEquals("second", pipe.reader().readLine());
        later.join();
    }

    @Test
    void aReaderWaitingWhileTheLastWriterEndsStillGetsTheNextLine() throws Exception {
        InMemoryPipe pipe = InMemoryPipe.open();
        // The writer stays alive a while after its line, so the reader below is
        // already parked on an empty pipe when the writer ends.
        Thread writer = Thread.ofVirtual().start(() -> {
            writeLine(pipe, "first");
            sleep(WRITER_LINGERS_MS);
        });
        assertEquals("first", pipe.reader().readLine());

        // A new writer comes only after the window in which a parked PipedReader
        // gives up on a dead writer.
        CompletableFuture<Void> later = CompletableFuture.runAsync(() -> {
            join(writer);
            sleep(PAST_THE_PIPED_WINDOW_MS);
            writeLine(pipe, "second");
        });
        assertEquals("second", pipe.reader().readLine());
        later.join();
    }

    @Test
    void closingTheWriterIsEndOfStreamForTheReader() throws Exception {
        InMemoryPipe pipe = InMemoryPipe.open();
        writeFromAThreadThatEnds(pipe, "only");
        pipe.writer().close();
        assertEquals("only", pipe.reader().readLine());
        assertNull(pipe.reader().readLine(), "a closed writer must read as end of stream");
    }

    private static void writeFromAThreadThatEnds(InMemoryPipe pipe, String line) throws InterruptedException {
        Thread writer = Thread.ofVirtual().start(() -> writeLine(pipe, line));
        writer.join();
    }

    private static void writeLine(InMemoryPipe pipe, String line) {
        try {
            pipe.writer().write(line);
            pipe.writer().write("\n");
            pipe.writer().flush();
        } catch (IOException failed) {
            throw new IllegalStateException(failed.toString(), failed);
        }
    }

    private static void join(Thread thread) {
        try {
            thread.join();
        } catch (InterruptedException interrupted) {
            Thread.currentThread().interrupt();
            throw new IllegalStateException(interrupted);
        }
    }

    private static void sleep(long millis) {
        try {
            Thread.sleep(millis);
        } catch (InterruptedException interrupted) {
            Thread.currentThread().interrupt();
            throw new IllegalStateException(interrupted);
        }
    }
}
