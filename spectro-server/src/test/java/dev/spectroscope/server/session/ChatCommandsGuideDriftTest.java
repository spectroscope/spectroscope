package dev.spectroscope.server.session;

import org.junit.jupiter.api.Test;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;

import static org.assertj.core.api.Assertions.assertThat;
import static org.junit.jupiter.api.Assumptions.assumeTrue;

/**
 * Card 471, round three: the guide's Commands section holds one closed panel
 * per command, and the panels say what the page does.
 *
 * <p>A review commit once removed the body and the closing tag of the
 * {@code /clear} panel. The callout stayed open and swallowed the next
 * chapter, and nothing went red. This test reads the guide part the way the
 * builder stitches it.</p>
 */
class ChatCommandsGuideDriftTest {

    private static final Path PART = Path.of("docs/guide-assets/parts/04-web-chat.html");

    @Test
    void eachCommandHasItsOwnClosedPanelBeforeTheNextChapter() throws IOException {
        String section = section();
        for (String command : new String[] {"/compact", "/clear"}) {
            String title = "<div class=\"co-title\">" + command + "</div>";
            int at = section.indexOf(title);
            assertThat(at).as("the panel for " + command).isGreaterThanOrEqualTo(0);
            String rest = section.substring(at + title.length());
            int close = rest.indexOf("</div>");
            assertThat(close).as(command + " panel is closed").isGreaterThanOrEqualTo(0);
            String body = rest.substring(0, close);
            assertThat(body).as(command + " panel has no other panel inside").doesNotContain("<div");
            assertThat(body.replaceAll("<[^>]+>", " ").trim().split("\\s+").length)
                    .as(command + " panel says something").isGreaterThan(40);
        }
        assertThat(count(section, "<div")).as("every div in the section is closed")
                .isEqualTo(count(section, "</div>"));
    }

    @Test
    void theClearPanelSaysTheRingStaysWithAnEstimateUntilTheNextAnswer() throws IOException {
        String section = section();
        String clear = section.substring(section.indexOf("<div class=\"co-title\">/clear</div>"));
        assertThat(clear).contains("context ring stays");
        assertThat(clear).contains("estimate of the system prompt and the tools");
        assertThat(clear).contains("until the next answer reports");
    }

    @Test
    void theCompactPanelSaysWhatTheFooterAndALateStopShow() throws IOException {
        String section = section();
        String compact = section.substring(section.indexOf("<div class=\"co-title\">/compact</div>"));
        assertThat(compact).contains("footer reads \"compacting\"");
        assertThat(compact).contains("after the summary is done");
    }

    @Test
    void theRefusalInTheGuideIsTheOneTheServerSends() throws IOException {
        assertThat(section()).contains(SessionConnection.RUN_ACTIVE);
    }

    /** The Commands section, whitespace-collapsed, up to the next chapter. */
    private static String section() throws IOException {
        Path root = repoRoot();
        assumeTrue(root != null && Files.isRegularFile(root.resolve(PART)), "not running from a source checkout");
        String part = Files.readString(root.resolve(PART)).replaceAll("\\s+", " ");
        int start = part.indexOf("<h2 id=\"ch-chat-commands\">");
        assertThat(start).as("the Commands chapter").isGreaterThanOrEqualTo(0);
        int end = part.indexOf("<h2", start + 4);
        return end < 0 ? part.substring(start) : part.substring(start, end);
    }

    private static int count(String text, String token) {
        int n = 0;
        for (int at = text.indexOf(token); at >= 0; at = text.indexOf(token, at + 1)) {
            n++;
        }
        return n;
    }

    /** Walks up to the directory holding the Gradle settings file. */
    private static Path repoRoot() {
        for (Path candidate = Path.of("").toAbsolutePath();
                candidate != null; candidate = candidate.getParent()) {
            if (Files.isRegularFile(candidate.resolve("settings.gradle.kts"))) {
                return candidate;
            }
        }
        return null;
    }
}
