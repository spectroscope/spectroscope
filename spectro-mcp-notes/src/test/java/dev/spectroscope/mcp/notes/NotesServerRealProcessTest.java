package dev.spectroscope.mcp.notes;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import java.io.BufferedReader;
import java.io.BufferedWriter;
import java.io.File;
import java.io.InputStreamReader;
import java.io.OutputStreamWriter;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.concurrent.TimeUnit;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.junit.jupiter.api.Assumptions.assumeTrue;

/**
 * The one end-to-end proof that the notes program works as a REAL child process
 * over REAL stdin/stdout — exercising {@link ProcessBuilder} spawn, the stderr
 * redirect (server logs must not corrupt the JSON-RPC stdout), and clean destroy.
 * The in-JVM {@link NotesServerStdioTest} covers the request mapping; this one
 * covers the process seam that {@code StdioTransport} relies on in production.
 *
 * <p>Launched as {@code java -cp <runtimeClasspath> dev.spectroscope.mcp.notes.NotesServer
 * <notesDir>} using the same JDK that runs the tests; the classpath and main class
 * are injected by the Gradle {@code test} task, so this runs in a normal
 * {@code ./gradlew build}. It skips only if that wiring is genuinely absent.
 */
class NotesServerRealProcessTest {

    private static final ObjectMapper JSON = new ObjectMapper();

    @Test
    void spawnsTheNotesProgramAndSearchesOverRealStdio(@TempDir Path notesDir) throws Exception {
        String classpath = System.getProperty("spectroscope.notes.runtimeClasspath");
        String mainClass = System.getProperty("spectro.notes.mainClass");
        String javaHome = System.getProperty("spectroscope.notes.javaHome", System.getProperty("java.home"));
        assumeTrue(classpath != null && !classpath.isBlank(),
                "runtime classpath not injected by the build; skipping the real-process test");
        assumeTrue(mainClass != null, "main class not injected by the build");

        // Seed a note the search must surface, plus a decoy that must not match.
        Files.writeString(notesDir.resolve("note-0000-gradle.txt"),
                "remember to run the gradle wrapper before pushing", StandardCharsets.UTF_8);
        Files.writeString(notesDir.resolve("note-0001-cat.txt"),
                "the cat sleeps on the warm laptop", StandardCharsets.UTF_8);

        String javaBin = javaHome + File.separator + "bin" + File.separator + "java";
        ProcessBuilder pb = new ProcessBuilder(
                javaBin, "-cp", classpath, mainClass, notesDir.toString());
        // stderr is server logs; keep it out of the protocol stream (mirrors StdioTransport).
        Path stderrLog = notesDir.resolve("server.stderr.log");
        pb.redirectError(ProcessBuilder.Redirect.to(stderrLog.toFile()));

        Process process = pb.start();
        try (BufferedWriter toServer = new BufferedWriter(
                new OutputStreamWriter(process.getOutputStream(), StandardCharsets.UTF_8));
             BufferedReader fromServer = new BufferedReader(
                     new InputStreamReader(process.getInputStream(), StandardCharsets.UTF_8))) {

            JsonNode init = roundTrip(toServer, fromServer,
                    "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"initialize\",\"params\":{}}");
            assertEquals("2024-11-05", init.get("result").get("protocolVersion").asText());

            JsonNode list = roundTrip(toServer, fromServer,
                    "{\"jsonrpc\":\"2.0\",\"id\":2,\"method\":\"tools/list\",\"params\":{}}");
            var names = list.get("result").get("tools").findValuesAsText("name");
            assertTrue(names.contains("search_notes"));
            assertTrue(names.contains("add_note"));

            JsonNode call = roundTrip(toServer, fromServer,
                    "{\"jsonrpc\":\"2.0\",\"id\":3,\"method\":\"tools/call\",\"params\":"
                            + "{\"name\":\"search_notes\",\"arguments\":{\"query\":\"gradle\",\"limit\":5}}}");
            String text = call.get("result").get("content").get(0).get("text").asText();
            assertTrue(text.contains("note-0000-gradle.txt"),
                    "the real process should surface the seeded gradle note, got: " + text);
            assertTrue(!text.contains("note-0001-cat.txt"),
                    "the decoy cat note must not match 'gradle'");
        } finally {
            // Clean teardown: closing stdin ends the server's read loop; destroy as a backstop.
            process.destroy();
            if (!process.waitFor(5, TimeUnit.SECONDS)) {
                process.destroyForcibly();
            }
        }
    }

    /** Write one JSON-RPC request line and read exactly one response line back. */
    private static JsonNode roundTrip(BufferedWriter out, BufferedReader in, String request) throws Exception {
        out.write(request);
        out.write('\n');
        out.flush();
        String line = in.readLine();
        assertNotNull(line, "the server closed stdout before answering: " + request);
        return JSON.readTree(line);
    }
}
