package dev.spectroscope.server;

/**
 * The client-to-server wire for the shell socket, decoded as a pure function.
 *
 * <p>A WebSocket frame already carries its own length, so there is no length
 * prefix here: the first byte is the opcode and the rest is payload. Two opcodes
 * exist and nothing else is tolerated — this is the one endpoint where a
 * misunderstood byte would be typed into a real shell, so the caller closes the
 * connection on anything it cannot name rather than skipping it.</p>
 *
 * <pre>
 *   0x00 | bytes                     keystrokes
 *   0x01 | rows u16 BE | cols u16 BE  resize (exactly four payload bytes)
 * </pre>
 */
final class ShellFrame {

    /** Largest keystroke payload in one frame — a paste, not a file. */
    static final int MAX_DATA = 64 * 1024;
    static final int MAX_ROWS = 1000;
    static final int MAX_COLS = 1000;

    /** The two things a client may say. */
    enum Kind { DATA, RESIZE }

    /**
     * One decoded frame.
     *
     * @param kind which opcode it was
     * @param data the keystrokes for {@link Kind#DATA}, empty otherwise
     * @param rows the clamped height for {@link Kind#RESIZE}, 0 otherwise
     * @param cols the clamped width for {@link Kind#RESIZE}, 0 otherwise
     */
    record Frame(Kind kind, byte[] data, int rows, int cols) {}

    private ShellFrame() {
    }

    /**
     * Decode one frame.
     *
     * @param payload the raw WebSocket binary payload — untrusted
     * @return the decoded frame
     * @throws IllegalArgumentException for an empty frame, an unknown opcode, a
     *         resize of the wrong length, or a payload over the cap
     */
    static Frame decode(byte[] payload) {
        if (payload == null || payload.length == 0) {
            throw new IllegalArgumentException("empty shell frame");
        }
        int opcode = payload[0] & 0xff;
        switch (opcode) {
            case 0x00 -> {
                int length = payload.length - 1;
                if (length > MAX_DATA) {
                    throw new IllegalArgumentException("shell frame of " + length + " bytes");
                }
                byte[] data = new byte[length];
                System.arraycopy(payload, 1, data, 0, length);
                return new Frame(Kind.DATA, data, 0, 0);
            }
            case 0x01 -> {
                if (payload.length != 5) {
                    throw new IllegalArgumentException("resize frame must carry four bytes");
                }
                int rows = ((payload[1] & 0xff) << 8) | (payload[2] & 0xff);
                int cols = ((payload[3] & 0xff) << 8) | (payload[4] & 0xff);
                // Clamped, not trusted: the window is client-supplied and ends up
                // in a kernel ioctl and in every curses program's allocations.
                return new Frame(Kind.RESIZE, new byte[0],
                        clamp(rows, MAX_ROWS), clamp(cols, MAX_COLS));
            }
            default -> throw new IllegalArgumentException("unknown shell opcode " + opcode);
        }
    }

    /**
     * Clamp a window dimension into a sane range.
     *
     * @param value the requested value
     * @param max   the upper bound
     * @return the value inside [1, max]
     */
    static int clamp(int value, int max) {
        return Math.max(1, Math.min(max, value));
    }
}
