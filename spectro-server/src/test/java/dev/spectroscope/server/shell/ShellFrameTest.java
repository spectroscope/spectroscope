package dev.spectroscope.server.shell;

import org.junit.jupiter.api.Test;

import static org.junit.jupiter.api.Assertions.assertArrayEquals;
import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;

/**
 * The client-to-server wire for the shell socket. Everything here is untrusted
 * input from a browser tab, so the decoder is a pure function with a hard cap
 * and exactly two accepted opcodes; anything else throws and the caller closes
 * the socket rather than guessing.
 */
class ShellFrameTest {

    @Test
    void opcodeZeroIsKeystrokes() {
        ShellFrame.Frame frame = ShellFrame.decode(new byte[] {0x00, 'l', 's', '\n'});
        assertEquals(ShellFrame.Kind.DATA, frame.kind());
        assertArrayEquals("ls\n".getBytes(), frame.data());
    }

    @Test
    void opcodeOneIsAResize() {
        // rows=48, cols=200, both u16 big-endian
        ShellFrame.Frame frame = ShellFrame.decode(new byte[] {0x01, 0x00, 48, 0x00, (byte) 200});
        assertEquals(ShellFrame.Kind.RESIZE, frame.kind());
        assertEquals(48, frame.rows());
        assertEquals(200, frame.cols());
    }

    @Test
    void anAbsurdWindowIsClampedNotTrusted() {
        ShellFrame.Frame huge = ShellFrame.decode(
                new byte[] {0x01, (byte) 0xff, (byte) 0xff, (byte) 0xff, (byte) 0xff});
        assertEquals(ShellFrame.MAX_ROWS, huge.rows());
        assertEquals(ShellFrame.MAX_COLS, huge.cols());
        ShellFrame.Frame zero = ShellFrame.decode(new byte[] {0x01, 0, 0, 0, 0});
        assertEquals(1, zero.rows());
        assertEquals(1, zero.cols());
    }

    @Test
    void aResizeOfTheWrongLengthIsRefused() {
        assertThrows(IllegalArgumentException.class,
                () -> ShellFrame.decode(new byte[] {0x01, 0x00, 24, 0x00}));
    }

    @Test
    void anEmptyFrameIsRefused() {
        assertThrows(IllegalArgumentException.class, () -> ShellFrame.decode(new byte[0]));
    }

    @Test
    void anUnknownOpcodeIsRefused() {
        assertThrows(IllegalArgumentException.class,
                () -> ShellFrame.decode(new byte[] {0x07, 'x'}));
    }

    @Test
    void anOversizedPasteIsRefused() {
        byte[] tooBig = new byte[ShellFrame.MAX_DATA + 2];
        tooBig[0] = 0x00;
        assertThrows(IllegalArgumentException.class, () -> ShellFrame.decode(tooBig));
    }
}
