package dev.spectroscope.core.peer;

import java.io.IOException;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.io.Reader;
import java.nio.charset.StandardCharsets;

/**
 * Reads newline delimited UTF-8 lines with a hard cap of
 * {@link PeerLimits#LINE_CAP_CHARS} characters (card 502 criterion 3). A
 * longer line throws {@link LineTooLong}, and the caller closes the connection.
 */
public final class LineReader {

    /** A line longer than the cap. */
    public static final class LineTooLong extends IOException {
        /** Builds the refusal. */
        public LineTooLong() {
            super("a frame line longer than " + PeerLimits.LINE_CAP_CHARS + " characters");
        }
    }

    private final Reader in;
    private final char[] buffer = new char[8192];
    private int position;
    private int limit;

    /** @param in the socket's input */
    public LineReader(InputStream in) {
        this.in = new InputStreamReader(in, StandardCharsets.UTF_8);
    }

    /**
     * @return the next line without its newline, or null at the end of the stream
     * @throws IOException on a read failure, or {@link LineTooLong}
     */
    public String readLine() throws IOException {
        StringBuilder line = new StringBuilder();
        while (true) {
            if (position == limit) {
                limit = in.read(buffer);
                position = 0;
                if (limit <= 0) {
                    limit = 0;
                    return line.isEmpty() ? null : line.toString();
                }
            }
            char c = buffer[position++];
            if (c == '\n') {
                return line.toString();
            }
            if (line.length() >= PeerLimits.LINE_CAP_CHARS) {
                throw new LineTooLong();
            }
            line.append(c);
        }
    }
}
