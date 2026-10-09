package dev.spectroscope.cli;

import org.junit.jupiter.api.Test;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * Card 473, round three: the interactive CLI names the files beside its
 * session in the main run_start, by the same rule as the server
 * ({@code WireReference}). The loop reads stdin and has no seam a unit test
 * can drive, so this pins the wiring in the source: every place that opens a
 * session's llm wire opens its reference too, and the run loop stamps each
 * event before the first consumer sees it.
 */
class CliWireReferenceDriftTest {

    private static String source() throws IOException {
        return Files.readString(Path.of("src/main/java/dev/spectroscope/cli/SpectroCli.java"));
    }

    private static int count(String text, String regex) {
        Matcher m = Pattern.compile(regex).matcher(text);
        int n = 0;
        while (m.find()) {
            n++;
        }
        return n;
    }

    @Test
    void everyOpenedLlmWireOpensItsReference() throws IOException {
        String src = source();
        int wires = count(src, "llmWire = LlmWireRecorder\\.forSession\\(store\\.id\\(\\)\\)");
        assertTrue(wires >= 2, "positive control: the fresh and the /clear session both open a wire");
        assertEquals(wires, count(src, "wireReference = new dev\\.spectroscope\\.core\\.wire\\.WireReference\\(store\\.id\\(\\), true\\)"),
                "one reference per session the CLI opens");
    }

    @Test
    void theRunLoopStampsBeforeTheFileSeesTheEvent() throws IOException {
        String src = source();
        int loop = src.indexOf("subagents.run(agent, input,");
        assertTrue(loop > 0, "positive control: the run loop is there");
        String body = src.substring(loop, src.indexOf("} finally {", loop));
        int stamp = body.indexOf("RunEvent event = wireReference.stamp(rawEvent);");
        int file = body.indexOf("tracing.onEvent(event);");
        assertTrue(stamp > 0, "the loop stamps the event");
        assertTrue(file > stamp, "and writes the stamped event to the file");
    }
}
