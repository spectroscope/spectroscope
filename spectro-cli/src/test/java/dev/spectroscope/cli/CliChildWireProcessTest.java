package dev.spectroscope.cli;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.sun.net.httpserver.HttpServer;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.Timeout;
import org.junit.jupiter.api.io.TempDir;

import java.io.IOException;
import java.io.OutputStream;
import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;
import java.util.concurrent.TimeUnit;
import java.util.stream.Stream;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * Card 231, the CLI half of the same gap {@code SessionChildWireTest} pins on
 * the server: a subagent spawned from the REPL must write its exchange onto the
 * SAME {@code .llm.jsonl} the parent session records. The CLI door passed a
 * positional {@code null} for the recorder, so a child spawned at the terminal
 * ran off the record while card 184 claimed otherwise.
 *
 * <p>The honest way to drive the REPL is the REPL: a REAL child JVM runs
 * {@link SpectroCli} with {@code -Duser.home} pointing into a temp folder, a
 * scripted loopback backend makes the one prompt spawn one explore child, and
 * the assertion reads the wire file out of that temp home — the same
 * real-process pattern {@code NodeProcessProofTest} uses.</p>
 *
 * <p>Bite proof (measured): hand the positional {@code null} back at
 * {@code registerTools}'s {@code SubagentConfig} and this goes red with no
 * child agentId on the wire while the parent's lines stay — restore, green.</p>
 */
@Timeout(value = 120, unit = TimeUnit.SECONDS)
class CliChildWireProcessTest {

    private static final ObjectMapper JSON = new ObjectMapper();

    /** The explore child's system prompt opener — the parent's request also
     *  carries the word "subagent" in its spawn-tool descriptions, so the mock
     *  keys on the role prompt, never the word. */
    private static final String CHILD_PROMPT_MARKER = "You are a research subagent (type explore)";

    private HttpServer mock;

    @AfterEach
    void stopMock() {
        if (mock != null) {
            mock.stop(0);
        }
    }

    /** The same scripted Ollama the server-door test speaks: spawn tool call,
     *  child memo, closing answer.
     *  @return the base url for the child JVM's config */
    private String startScriptedBackend() throws IOException {
        mock = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
        mock.createContext("/api/chat", exchange -> {
            String body = new String(exchange.getRequestBody().readAllBytes(), StandardCharsets.UTF_8);
            String ndjson;
            if (body.contains(CHILD_PROMPT_MARKER)) {
                ndjson = """
                        {"message":{"content":"memo: nothing to see here."},"done":false}
                        {"message":{"content":""},"done":true,"prompt_eval_count":6,"eval_count":3}
                        """;
            } else if (body.contains("\"role\":\"tool\"")) {
                ndjson = """
                        {"message":{"content":"Delegated and done."},"done":false}
                        {"message":{"content":""},"done":true,"prompt_eval_count":9,"eval_count":2}
                        """;
            } else {
                ndjson = """
                        {"message":{"content":"","tool_calls":[{"function":{"name":"spawn_agent","arguments":{"type":"explore","task":"look around the workspace"}}}]},"done":false}
                        {"message":{"content":""},"done":true,"prompt_eval_count":8,"eval_count":4}
                        """;
            }
            byte[] answer = ndjson.getBytes(StandardCharsets.UTF_8);
            exchange.getResponseHeaders().add("Content-Type", "application/x-ndjson");
            exchange.sendResponseHeaders(200, answer.length);
            try (OutputStream out = exchange.getResponseBody()) {
                out.write(answer);
            }
        });
        mock.start();
        return "http://127.0.0.1:" + mock.getAddress().getPort();
    }

    @Test
    void aChildSpawnedAtTheReplWritesOnTheSessionsLlmWire(@TempDir Path home) throws Exception {
        String baseUrl = startScriptedBackend();
        Path config = home.resolve(".spectro").resolve("config.json");
        Files.createDirectories(config.getParent());
        Files.writeString(config, """
                { "provider": "ollama", "model": "qwen3", "baseUrl": "%s" }
                """.formatted(baseUrl));

        Process cli = new ProcessBuilder(
                System.getProperty("java.home") + "/bin/java",
                "-Duser.home=" + home,
                "-cp", System.getProperty("java.class.path"),
                SpectroCli.class.getName())
                .redirectErrorStream(true)
                .start();
        // One prompt, then end-of-input: the REPL runs the turn synchronously
        // and leaves on the EOF, exactly like a piped terminal session.
        try (OutputStream stdin = cli.getOutputStream()) {
            stdin.write("Delegate: start exactly one explore subagent.\n"
                    .getBytes(StandardCharsets.UTF_8));
        }
        String transcript = new String(cli.getInputStream().readAllBytes(), StandardCharsets.UTF_8);
        assertTrue(cli.waitFor(90, TimeUnit.SECONDS),
                "the piped REPL session ends on EOF; transcript:\n" + transcript);
        assertEquals(0, cli.exitValue(), "a regular REPL exit is 0");

        Path wireDir = home.resolve(".spectro").resolve("llm-wire");
        assertTrue(Files.isDirectory(wireDir),
                "test premise: the CLI session records its llm-wire at all; transcript:\n"
                        + transcript);
        List<Path> wireFiles;
        try (Stream<Path> files = Files.list(wireDir)) {
            wireFiles = files.filter(file -> file.getFileName().toString().endsWith(".llm.jsonl"))
                    .toList();
        }
        assertEquals(1, wireFiles.size(), "one session, one sidecar: " + wireFiles);

        List<String> requestAgents = Files.readAllLines(wireFiles.get(0)).stream()
                .map(CliChildWireProcessTest::parse)
                .filter(line -> "llm_request".equals(line.path("type").asText()))
                .map(line -> line.path("agentId").asText())
                .toList();
        assertTrue(requestAgents.contains("main"),
                "test premise: the parent's own calls are on the record, got: " + requestAgents);
        assertTrue(requestAgents.contains("explore-1"),
                "card 231: a child spawned at the terminal writes on the SAME wire — child"
                        + " agentIds on file: "
                        + requestAgents.stream().filter(id -> !"main".equals(id)).toList());
    }

    private static JsonNode parse(String line) {
        try {
            return JSON.readTree(line);
        } catch (IOException malformed) {
            throw new AssertionError("unparseable wire line: " + line, malformed);
        }
    }
}
