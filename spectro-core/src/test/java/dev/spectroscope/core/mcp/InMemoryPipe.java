package dev.spectroscope.core.mcp;

import java.io.BufferedReader;
import java.io.BufferedWriter;
import java.io.IOException;
import java.io.InputStreamReader;
import java.io.OutputStreamWriter;
import java.nio.channels.Channels;
import java.nio.channels.Pipe;
import java.nio.charset.StandardCharsets;

/**
 * One direction of an in-memory line pipe for the MCP tests: what is written to
 * {@link #writer()} is read from {@link #reader()}.
 *
 * <p>Built on {@link java.nio.channels.Pipe}, not on {@code PipedReader} and
 * {@code PipedWriter}. A {@code PipedReader} remembers the last thread that wrote
 * to it, and once that thread has ended and the buffer is empty, a read fails:
 * at once with "Write end dead" if the reader arrives after the writer ended, or
 * with "Pipe broken" after up to three one-second waits if it was already parked.
 * {@link McpClient} runs every {@code tools/call} on a fresh virtual thread that
 * ends with the call, so a scripted server on a {@code PipedReader} died whenever
 * a busy runner paused it at the wrong moment. A {@code Pipe} has no rule about
 * threads. It keeps what the tests rely on: closing the writer is end of stream
 * for the reader, and a blocked read returns on an interrupt because the source
 * channel is interruptible.
 *
 * @param reader the reading end, UTF-8
 * @param writer the writing end, UTF-8; closing it ends the stream
 */
record InMemoryPipe(BufferedReader reader, BufferedWriter writer) {

    /**
     * Open a fresh pipe.
     *
     * @return both ends, connected
     * @throws IOException when the platform cannot open a pipe
     */
    static InMemoryPipe open() throws IOException {
        Pipe pipe = Pipe.open();
        BufferedReader reader = new BufferedReader(new InputStreamReader(
                Channels.newInputStream(pipe.source()), StandardCharsets.UTF_8));
        BufferedWriter writer = new BufferedWriter(new OutputStreamWriter(
                Channels.newOutputStream(pipe.sink()), StandardCharsets.UTF_8));
        return new InMemoryPipe(reader, writer);
    }
}
