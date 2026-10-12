package dev.spectroscope.server.session;

import org.junit.jupiter.api.Test;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * Card 540: {@link SessionLaunchLifetimeTest} carries a copy of the port rule of
 * spectro-core's test class {@code ClaimablePorts}, because this module cannot see
 * that module's test classes. The two {@code claimable} methods must stay the same
 * text, so a change to one without the other goes red here.
 */
class ClaimablePortsTwinTest {

    private static final Path ORIGINAL = Path.of(
            "../spectro-core/src/test/java/dev/spectroscope/core/launch/ClaimablePorts.java");
    private static final Path COPY = Path.of(
            "src/test/java/dev/spectroscope/server/session/SessionLaunchLifetimeTest.java");

    @Test
    void theServerCopyOfTheClaimableCheckIsTheSameTextAsTheOriginal() throws IOException {
        String original = claimableOf(ORIGINAL);
        String copy = claimableOf(COPY);
        assertThat(original).as("positive control: the original has the bind it checks with")
                .contains("socket.setReuseAddress(false);")
                .contains("InetAddress.getByName(\"localhost\")");
        assertThat(copy).as("the copy in " + COPY + " is the original in " + ORIGINAL).isEqualTo(original);
    }

    /** The body of {@code static boolean claimable(int port)}, whitespace collapsed. */
    private static String claimableOf(Path source) throws IOException {
        String text = Files.readString(source);
        String head = "static boolean claimable(int port) {";
        int start = text.indexOf(head);
        assertThat(start).as("test premise: " + source + " declares " + head).isNotNegative();
        int depth = 0;
        for (int i = start + head.length() - 1; i < text.length(); i++) {
            char c = text.charAt(i);
            if (c == '{') {
                depth++;
            } else if (c == '}' && --depth == 0) {
                return text.substring(start, i + 1).replaceAll("\\s+", " ");
            }
        }
        throw new AssertionError("test premise: the method in " + source + " closes");
    }
}
