package dev.spectroscope.server.llm;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import dev.spectroscope.cli.voice.CommandRunner;
import dev.spectroscope.core.wire.LlmWireRecorder;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import java.io.BufferedReader;
import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Base64;
import java.util.List;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * Card 184, the stt leg: the spoken bytes ARE a model exchange, so a transcribe
 * call leaves an llm-wire record — the recording verbatim (base64) on the
 * request line, whisper's transcript on the response line, and the failure path
 * honest about its status.
 */
class TranscribeWireTest {

    private static final ObjectMapper JSON = new ObjectMapper();

    /** Same fake as TranscribeControllerTest: whisper answers, and it is the only
     *  child process there is since card 187 step 5.4 retired the conversion. */
    private static final class FakeRunner implements CommandRunner {
        @Override
        public long record(List<String> command, BufferedReader stopSignal) {
            throw new UnsupportedOperationException("the server never records");
        }

        @Override
        public List<String> runCapturingOutput(List<String> command) {
            return List.of("hallo spectroscope");
        }
    }

    @Test
    void aTranscribeCallRecordsAudioBytesAndTranscript(@TempDir Path dir) throws Exception {
        Path wireFile = dir.resolve("stt.llm.jsonl");
        Path model = dir.resolve("ggml-small.bin");
        Files.writeString(model, "present");
        byte[] audio = VoiceFixtures.clip();
        try (LlmWireRecorder recorder = new LlmWireRecorder(wireFile, 1_000_000)) {
            TranscribeController controller =
                    new TranscribeController(new FakeRunner(), model, true, recorder);
            controller.transcribe(audio);
        }

        List<String> lines = Files.readAllLines(wireFile);
        assertEquals(2, lines.size());
        JsonNode request = JSON.readTree(lines.get(0));
        JsonNode response = JSON.readTree(lines.get(1));

        assertEquals("stt", request.get("kind").asText());
        // "encoded": the base64 is the recording's own, no socket carried it —
        // and a process pipeline has no HTTP method to claim.
        assertEquals("encoded", request.get("fidelity").asText());
        assertNull(request.get("method"));
        assertEquals("composer", request.get("agentId").asText());
        assertEquals("whisper-cpp", request.get("provider").asText());
        assertEquals("ggml-small.bin", request.get("model").asText());
        // The url names the pipeline, and there is one process in it now.
        assertEquals("process://whisper-cli", request.get("url").asText());
        // The spoken bytes ride VERBATIM, base64-encoded for the JSON line.
        assertEquals(Base64.getEncoder().encodeToString(audio), request.get("body").asText());

        assertEquals(200, response.get("status").asInt());
        assertEquals("process-output", response.get("fidelity").asText());
        assertEquals("hallo spectroscope", response.get("body").asText());
    }

    @Test
    void aFailedPipelineRecordsTheErrorNotSilence(@TempDir Path dir) throws Exception {
        Path wireFile = dir.resolve("stt-fail.llm.jsonl");
        // The model is PRESENT and the child process is what fails. Since leg 2b
        // readiness is probed on every call, an absent model is refused before
        // the pipeline runs at all — which is the honest answer to "stt is not
        // installed" and is a different situation from "the pipeline broke".
        // This test is about the second, so it has to produce the second.
        Path model = dir.resolve("ggml-small.bin");
        Files.writeString(model, "present");
        CommandRunner breaks = new CommandRunner() {
            @Override
            public long record(List<String> command, BufferedReader stopSignal) {
                throw new UnsupportedOperationException("the server never records");
            }

            @Override
            public List<String> runCapturingOutput(List<String> command) throws IOException {
                throw new IOException("whisper-cli exited 1: model load failed — see setup-stt");
            }
        };
        try (LlmWireRecorder recorder = new LlmWireRecorder(wireFile, 1_000_000)) {
            TranscribeController controller =
                    new TranscribeController(breaks, model, true, recorder);
            controller.transcribe(VoiceFixtures.clip());
        }

        List<String> lines = Files.readAllLines(wireFile);
        assertEquals(2, lines.size());
        JsonNode response = JSON.readTree(lines.get(1));
        assertEquals(503, response.get("status").asInt());
        assertTrue(response.get("error").asText().contains("setup-stt"),
                "the record carries the readable cause: " + response.get("error"));
    }

    /**
     * Leg 2b. The record existed and was invisible: voice happens before any
     * session exists, so it lands in a shared day file and there is no session
     * socket to mirror onto. The transcript alone reached the browser, and the
     * whole exchange — the spoken bytes, the model, how long it took — showed up
     * in no trace anywhere.
     *
     * <p>So the exchange announces itself in THIS response, to the one caller
     * that certainly wants it: the browser that just spoke. What it needs is the
     * pair of ids that let it build its rows and then ask for the bytes.</p>
     */
    @Test
    void theTranscribeAnswerCarriesTheRecordTheBrowserCouldNotOtherwiseKnowAbout(@TempDir Path dir)
            throws Exception {
        Path model = dir.resolve("ggml-small.bin");
        Files.writeString(model, "present");
        try (LlmWireRecorder recorder = new LlmWireRecorder(dir.resolve("s.llm.jsonl"), 1_000_000)) {
            TranscribeController controller =
                    new TranscribeController(new FakeRunner(), model, true, recorder);

            Object body = controller.transcribe(VoiceFixtures.clip()).getBody();

            @SuppressWarnings("unchecked")
            java.util.Map<String, Object> answer = (java.util.Map<String, Object>) body;
            assertEquals("hallo spectroscope", answer.get("text"), "the transcript still leads");

            @SuppressWarnings("unchecked")
            java.util.Map<String, Object> wire = (java.util.Map<String, Object>) answer.get("wire");
            assertTrue(wire != null, "the answer names its own record");
            // The two ids that make the record reachable: the day file to ask,
            // and the exchange within it.
            assertTrue(String.valueOf(wire.get("session")).startsWith("stt-"),
                    "the day file the bytes live in, got " + wire.get("session"));
            assertTrue(!String.valueOf(wire.get("xid")).isBlank(), "the exchange to ask for");
            assertEquals("stt", wire.get("kind"));
            assertEquals("whisper-cpp", wire.get("provider"));
            assertEquals("ggml-small.bin", wire.get("model"));
            assertEquals(200, wire.get("status"));
            // A size the row can print without fetching anything.
            assertTrue((Long) wire.get("requestBytes") > 0, "the spoken bytes were measured");
        }
    }

    /** A run that never got as far as an exchange says the transcript and stops.
     *  An empty `wire` object would read as a record that got lost. */
    @Test
    void anAnswerWithNoRecordBehindItClaimsNone(@TempDir Path dir) throws Exception {
        Path absentModel = dir.resolve("gone").resolve("ggml-small.bin");
        try (LlmWireRecorder recorder = new LlmWireRecorder(dir.resolve("f.llm.jsonl"), 1_000_000)) {
            TranscribeController controller =
                    new TranscribeController(new FakeRunner(), absentModel, true, recorder);
            Object body = controller.transcribe(VoiceFixtures.clip()).getBody();
            @SuppressWarnings("unchecked")
            java.util.Map<String, Object> answer = (java.util.Map<String, Object>) body;
            // Either it failed before any exchange (no wire at all), or it
            // recorded one and says so honestly. What it must never do is carry
            // an empty shell.
            Object wire = answer.get("wire");
            assertTrue(wire == null || !((java.util.Map<?, ?>) wire).isEmpty());
        }
    }
}
