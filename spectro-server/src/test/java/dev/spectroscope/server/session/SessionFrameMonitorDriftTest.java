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

    @Test
    void theTwoPeerFramesAreSentUnderTheMonitor() throws IOException {
        // Card 502: the positive half. peer_message and peer_roster are new
        // senders; the walk above holds them to the monitor only if they exist.
        assumeTrue(Files.isRegularFile(SOURCE), "not running from a source checkout");
        String source = Files.readString(SOURCE);
        assertThat(source).contains("synchronized void sendPeerMessage(");
        assertThat(source).contains("synchronized void sendPeerRoster(");
        assertThat(source).contains("\"type\", \"peer_message\"");
        assertThat(source).contains("\"type\", \"peer_roster\"");
    }

    @Test
    void theOperatorsPeerMessageFrameIsRoutedToTheConnection() throws IOException {
        // Card 503: send_peer_message is inbound, from the page. The handler
        // routes it, and the connection method it calls sends its answer
        // through sendPeerMessage, which the walk above holds to the monitor.
        Path handler = SOURCE.resolveSibling("SpectroSocketHandler.java");
        assumeTrue(Files.isRegularFile(handler), "not running from a source checkout");
        assertThat(Files.readString(handler)).contains("case \"send_peer_message\"")
                .contains("connection.onSendPeerMessage(");
        assertThat(Files.readString(SOURCE)).contains("public void onSendPeerMessage(");
    }

    @Test
    void theLoopFramesAreRoutedAndSentUnderTheMonitor() throws IOException {
        // Card 504: set_loop is inbound, from the page; loop_info is outbound
        // and the walk above holds its sender to the monitor.
        Path handler = SOURCE.resolveSibling("SpectroSocketHandler.java");
        assumeTrue(Files.isRegularFile(handler), "not running from a source checkout");
        assertThat(Files.readString(handler)).contains("case \"set_loop\"").contains("connection.onSetLoop(");
        String source = Files.readString(SOURCE);
        assertThat(source).contains("public void onSetLoop(");
        assertThat(source).contains("synchronized void sendLoopInfo(");
        assertThat(source).contains("\"type\", \"loop_info\"");
    }
}
