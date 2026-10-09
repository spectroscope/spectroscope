package dev.spectroscope.server.session;

import org.junit.jupiter.api.Test;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

import static org.assertj.core.api.Assertions.assertThat;
import static org.junit.jupiter.api.Assumptions.assumeTrue;

/**
 * Card 471, round three: every method of {@link SessionConnection} that puts a
 * frame on the socket holds the connection's monitor.
 *
 * <p>{@code sendFrame} leaves the monitor to its callers, and a frame sent
 * from a virtual thread without it can overlap another send on the same
 * socket; Tomcat then throws and {@code sendFrame} swallows it, so the frame
 * is lost without a word. The closing {@code compaction_state} frame was such
 * a caller. A fake socket cannot show the race, so this test reads the
 * source: the enclosing declaration of every {@code sendFrame(} call must say
 * {@code synchronized}.</p>
 */
class SessionFrameMonitorDriftTest {

    private static final Path SOURCE =
            Path.of("src/main/java/dev/spectroscope/server/session/SessionConnection.java");

    /** A method or constructor declaration at class level (four spaces in). */
    private static final Pattern DECLARATION =
            Pattern.compile("^    (?! )(?!return|if|for|while|switch|try|catch|else|new )[\\w<>\\[\\],.? ]*\\b\\w+\\(.*$");

    @Test
    void everySenderOfAFrameHoldsTheMonitor() throws IOException {
        assumeTrue(Files.isRegularFile(SOURCE), "not running from a source checkout");
        List<String> lines = Files.readAllLines(SOURCE);
        List<String> callers = new ArrayList<>();
        List<String> unguarded = new ArrayList<>();
        String enclosing = null;
        Pattern call = Pattern.compile("(?<!boolean )\\bsendFrame\\(");
        for (String line : lines) {
            if (DECLARATION.matcher(line).matches() && !line.trim().startsWith("*")
                    && !line.trim().startsWith("//")) {
                enclosing = line.trim();
            }
            Matcher m = call.matcher(line);
            if (m.find() && !line.trim().startsWith("*") && !line.trim().startsWith("//")
                    && !line.contains("private boolean sendFrame(")) {
                callers.add(enclosing);
                if (enclosing == null || !enclosing.contains("synchronized")) {
                    unguarded.add(enclosing);
                }
            }
        }
        assertThat(callers).as("premise: the source has frame senders").hasSizeGreaterThan(5);
        assertThat(unguarded)
                .as("methods that call sendFrame without holding the monitor")
                .isEmpty();
    }
}
