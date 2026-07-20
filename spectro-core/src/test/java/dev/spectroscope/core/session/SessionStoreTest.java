package dev.spectroscope.core.session;

import com.fasterxml.jackson.databind.ObjectMapper;
import dev.spectroscope.core.events.RunEvent;
import dev.spectroscope.core.provider.LlmProvider.ImageContent;
import dev.spectroscope.core.provider.LlmProvider.ProviderContent;
import dev.spectroscope.core.provider.LlmProvider.ProviderMessage;
import dev.spectroscope.core.provider.LlmProvider.TextContent;
import dev.spectroscope.core.provider.LlmProvider.ToolCallContent;
import dev.spectroscope.core.provider.LlmProvider.ToolResultContent;
import org.junit.jupiter.api.Test;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardOpenOption;
import java.util.Base64;
import java.util.List;
import java.util.UUID;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertInstanceOf;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * The JSONL store: append-per-event, tolerant reads (torn trailing line),
 * the overview fold, and the resume reconstruction rules from
 * JSONL-FORMAT.md §5.2 (main agent only, orphaned tool_calls dropped).
 *
 * <p>The Gradle test task points {@code user.home} into the build directory,
 * so SESSIONS_DIR never touches the real home.</p>
 */
class SessionStoreTest {

    private static final ObjectMapper JSON = new ObjectMapper();

    private static String freshId() {
        return "test-" + UUID.randomUUID().toString().substring(0, 8);
    }

    @Test
    void appendWritesOneCompactJsonLinePerEvent() throws IOException {
        SessionStore store = new SessionStore(freshId());
        store.append(new RunEvent.RunStart("r1", "main", null, "hi", "anthropic", null, 1L));
        store.append(new RunEvent.TextDelta("main", "Hello", 2L));

        List<String> lines = Files.readAllLines(store.file(), StandardCharsets.UTF_8);
        assertEquals(2, lines.size());
        assertEquals("run_start", JSON.readTree(lines.get(0)).get("type").asText());
        assertTrue(lines.get(0).indexOf('\n') < 0, "compact JSON, no pretty printing");
    }

    @Test
    void aTornTrailingLineIsDiscardedOnRead() throws IOException {
        SessionStore store = new SessionStore(freshId());
        store.append(new RunEvent.RunStart("r1", "main", null, "hi", null, null, 1L));
        // Simulate a crash mid-write: an incomplete JSON line at the end.
        Files.writeString(store.file(), "{\"type\":\"text_delta\",\"agentId\":\"ma",
                StandardCharsets.UTF_8, StandardOpenOption.APPEND);

        List<RunEvent> events = SessionStore.readSessionEvents(store.id());
        assertEquals(1, events.size(), "the torn line must be dropped silently");
        assertInstanceOf(RunEvent.RunStart.class, events.getFirst());
    }

    @Test
    void listSessionsFoldsStartPromptTokensAndProvider() {
        String id = freshId();
        SessionStore store = new SessionStore(id);
        store.append(new RunEvent.RunStart("r1", "main", null, "Count the files", "ollama", null, 42L));
        store.append(new RunEvent.Usage("main", 100, 20, 43L));
        store.append(new RunEvent.Usage("main", 200, 30, 44L));

        SessionStore.SessionInfo info = SessionStore.listSessions().stream()
                .filter(session -> session.id().equals(id))
                .findFirst().orElseThrow();
        assertEquals("Count the files", info.firstPrompt());
        assertEquals(350, info.tokens());
        assertEquals("ollama", info.provider());
        assertEquals(42L, info.startedAt());
    }

    @Test
    void loadSessionReconstructsTheProviderHistory() throws IOException {
        String id = freshId();
        SessionStore store = new SessionStore(id);
        var input = JSON.createObjectNode().put("path", ".");
        store.append(new RunEvent.RunStart("r1", "main", null, "List the files", "anthropic", null, 1L));
        store.append(new RunEvent.TurnStart("main", 1, 2L));
        store.append(new RunEvent.TextDelta("main", "Let me ", 3L));
        store.append(new RunEvent.TextDelta("main", "look.", 4L));
        store.append(new RunEvent.ToolCall("main", "c1", "list_dir", input, 5L));
        store.append(new RunEvent.ToolResult("main", "c1", "src\nbuild.gradle.kts", false, 9L, 6L));
        store.append(new RunEvent.TurnStart("main", 2, 7L));
        store.append(new RunEvent.TextDelta("main", "Two entries.", 8L));
        store.append(new RunEvent.RunEnd("r1", "end_turn", 9L));

        List<ProviderMessage> history = SessionStore.loadSession(id);

        // user prompt · assistant(text+call) · user(result) · assistant(text)
        assertEquals(4, history.size());
        assertEquals(ProviderMessage.Role.USER, history.get(0).role());
        assertEquals("List the files", ((TextContent) history.get(0).content().getFirst()).text());
        assertEquals(ProviderMessage.Role.ASSISTANT, history.get(1).role());
        assertEquals("Let me look.", ((TextContent) history.get(1).content().get(0)).text());
        assertEquals("c1", ((ToolCallContent) history.get(1).content().get(1)).callId());
        assertEquals(ProviderMessage.Role.USER, history.get(2).role());
        assertEquals("c1", ((ToolResultContent) history.get(2).content().getFirst()).callId());
        assertEquals(ProviderMessage.Role.ASSISTANT, history.get(3).role());
    }

    @Test
    void orphanedToolCallsAreDroppedOnResume() throws IOException {
        String id = freshId();
        SessionStore store = new SessionStore(id);
        var input = JSON.createObjectNode().put("command", "ls");
        store.append(new RunEvent.RunStart("r1", "main", null, "Run ls", "anthropic", null, 1L));
        store.append(new RunEvent.TurnStart("main", 1, 2L));
        store.append(new RunEvent.TextDelta("main", "Running it.", 3L));
        // Crash after the tool_call, before the tool_result:
        store.append(new RunEvent.ToolCall("main", "c1", "run_command", input, 4L));

        List<ProviderMessage> history = SessionStore.loadSession(id);

        // The orphaned call must be gone, or the API rejects the history.
        boolean anyToolCall = history.stream()
                .flatMap(message -> message.content().stream())
                .anyMatch(ToolCallContent.class::isInstance);
        assertTrue(!anyToolCall, "orphaned tool_call must be dropped");
        assertEquals(2, history.size(), "user prompt + assistant text remain");
    }

    @Test
    void childAgentEventsDoNotEnterTheHistory() throws IOException {
        String id = freshId();
        SessionStore store = new SessionStore(id);
        store.append(new RunEvent.RunStart("r1", "main", null, "Compare things", "anthropic", null, 1L));
        store.append(new RunEvent.TurnStart("main", 1, 2L));
        store.append(new RunEvent.TextDelta("main", "Delegating.", 3L));
        // A stage-5 child writes into the same file:
        store.append(new RunEvent.AgentSpawn("explore-1", "main", "Explore apps/", 4L));
        store.append(new RunEvent.TurnStart("explore-1", 1, 5L));
        store.append(new RunEvent.TextDelta("explore-1", "child says things", 6L));
        store.append(new RunEvent.RunEnd("r1", "end_turn", 7L));

        List<ProviderMessage> history = SessionStore.loadSession(id);
        String allText = history.stream()
                .flatMap(message -> message.content().stream())
                .filter(TextContent.class::isInstance)
                .map(content -> ((TextContent) content).text())
                .reduce("", String::concat);
        assertTrue(allText.contains("Delegating."));
        assertTrue(!allText.contains("child says things"),
                "child agent text must not leak into the main history");
    }

    @Test
    void mergeAdjacentRolesCombinesSameRoleNeighbors() {
        List<ProviderMessage> merged = SessionStore.mergeAdjacentRoles(List.of(
                new ProviderMessage(ProviderMessage.Role.USER, List.of(new TextContent("a"))),
                new ProviderMessage(ProviderMessage.Role.USER, List.of(new TextContent("b"))),
                new ProviderMessage(ProviderMessage.Role.ASSISTANT, List.of(new TextContent("c")))));
        assertEquals(2, merged.size());
        assertEquals(2, merged.getFirst().content().size());
    }

    // ---- blob store ---------------------------------------------

    @Test
    void saveBlobWritesContentAddressedAndRoundTrips() throws IOException {
        String id = freshId();
        SessionStore.StoredBlob blob =
                SessionStore.saveBlob(id, "abc".getBytes(StandardCharsets.UTF_8), "image/png");

        // The sha256 of "abc" — the file name IS the content address.
        assertEquals("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
                blob.sha256());
        assertEquals(SessionStore.blobsDir(id).resolve(blob.sha256()).toString(), blob.blobPath());
        assertEquals("abc", new String(SessionStore.loadBlob(blob.blobPath()), StandardCharsets.UTF_8));
    }

    @Test
    void saveBlobDeduplicatesByHash() throws IOException {
        String id = freshId();
        SessionStore.StoredBlob first = SessionStore.saveBlob(id, new byte[] {1, 2, 3}, "image/jpeg");
        SessionStore.StoredBlob second = SessionStore.saveBlob(id, new byte[] {1, 2, 3}, "image/jpeg");

        assertEquals(first, second, "same bytes = same hash = same blob");
        try (var files = Files.list(SessionStore.blobsDir(id))) {
            assertEquals(1, files.count(), "the same image attached twice occupies disk space once");
        }
    }

    @Test
    void saveBlobRejectsUnsupportedMediaTypes() {
        IllegalArgumentException rejected = assertThrows(IllegalArgumentException.class,
                () -> SessionStore.saveBlob(freshId(), new byte[] {1}, "application/pdf"));
        assertTrue(rejected.getMessage().contains("Unsupported media type"));
    }

    @Test
    void attachmentsToContentReloadsBlobBytesAsBase64() {
        String id = freshId();
        byte[] bytes = {(byte) 0x89, 'P', 'N', 'G'};
        SessionStore.StoredBlob blob = SessionStore.saveBlob(id, bytes, "image/png");

        List<ProviderContent> content = SessionStore.attachmentsToContent(List.of(
                new RunEvent.Attachment("image", "image/png", blob.blobPath(), blob.sha256())));

        ImageContent image = assertInstanceOf(ImageContent.class, content.getFirst());
        assertEquals("image/png", image.mediaType());
        assertEquals(Base64.getEncoder().encodeToString(bytes), image.dataBase64());
    }

    @Test
    void aMissingBlobIsSkippedInsteadOfThrown() {
        // JSONL-FORMAT.md §7: a deleted blob must not make the session unreplayable.
        List<ProviderContent> content = SessionStore.attachmentsToContent(List.of(
                new RunEvent.Attachment("image", "image/png", "/nowhere/gone", "0".repeat(64))));
        assertTrue(content.isEmpty(), "the missing blob is skipped, nothing throws");
    }

    @Test
    void loadSessionPutsImageBlocksBackBeforeThePromptText() throws IOException {
        String id = freshId();
        SessionStore.StoredBlob blob =
                SessionStore.saveBlob(id, new byte[] {42}, "image/jpeg");
        RunEvent.Attachment attachment =
                new RunEvent.Attachment("image", "image/jpeg", blob.blobPath(), blob.sha256());

        SessionStore store = new SessionStore(id);
        store.append(new RunEvent.RunStart("r1", "main", null, "What is in this image?",
                "anthropic", List.of(attachment), 1L));
        store.append(new RunEvent.TurnStart("main", 1, 2L));
        store.append(new RunEvent.TextDelta("main", "A single byte.", 3L));
        store.append(new RunEvent.RunEnd("r1", "end_turn", 4L));

        List<ProviderMessage> history = SessionStore.loadSession(id);

        ProviderMessage firstUser = history.getFirst();
        assertEquals(ProviderMessage.Role.USER, firstUser.role());
        assertInstanceOf(ImageContent.class, firstUser.content().get(0),
                "the image block returns at its old position: BEFORE the text");
        assertEquals("What is in this image?",
                ((TextContent) firstUser.content().get(1)).text());
    }

    @Test
    void resumeSurvivesADeletedBlob() throws IOException {
        String id = freshId();
        SessionStore.StoredBlob blob = SessionStore.saveBlob(id, new byte[] {7}, "image/png");

        SessionStore store = new SessionStore(id);
        store.append(new RunEvent.RunStart("r1", "main", null, "Describe it", "anthropic",
                List.of(new RunEvent.Attachment("image", "image/png", blob.blobPath(), blob.sha256())),
                1L));
        store.append(new RunEvent.TurnStart("main", 1, 2L));
        store.append(new RunEvent.TextDelta("main", "Sure.", 3L));
        store.append(new RunEvent.RunEnd("r1", "end_turn", 4L));

        Files.delete(Path.of(blob.blobPath())); // the user hand-deleted the blob

        List<ProviderMessage> history = SessionStore.loadSession(id);
        ProviderMessage firstUser = history.getFirst();
        assertEquals(1, firstUser.content().size(), "the attachment is skipped, the text survives");
        assertEquals("Describe it", ((TextContent) firstUser.content().getFirst()).text());
    }

    // ---- voice input provenance ---------------------------------

    @Test
    void aLeadingVoiceInputLineIsAuditOnlyAndDoesNotChangeTheHistory() throws IOException {
        // the optional voice_input event is written BEFORE run_start to mark
        // provenance. It must never enter the provider history — a resumed voice turn
        // is byte-identical to a typed one. Build the SAME session twice, once with the
        // audit line and once without, and compare the reconstructed histories.
        String typedId = freshId();
        SessionStore typed = new SessionStore(typedId);
        typed.append(new RunEvent.RunStart("r1", "main", null, "What is in the README?",
                "anthropic", null, 2L));
        typed.append(new RunEvent.TurnStart("main", 1, 3L));
        typed.append(new RunEvent.TextDelta("main", "It documents the project.", 4L));
        typed.append(new RunEvent.RunEnd("r1", "end_turn", 5L));

        String voiceId = freshId();
        SessionStore voice = new SessionStore(voiceId);
        // The audit line precedes run_start, exactly as the /voice REPL writes it.
        voice.append(new RunEvent.VoiceInput("main", 3200, "ggml-small", 1L));
        voice.append(new RunEvent.RunStart("r1", "main", null, "What is in the README?",
                "anthropic", null, 2L));
        voice.append(new RunEvent.TurnStart("main", 1, 3L));
        voice.append(new RunEvent.TextDelta("main", "It documents the project.", 4L));
        voice.append(new RunEvent.RunEnd("r1", "end_turn", 5L));

        List<ProviderMessage> typedHistory = SessionStore.loadSession(typedId);
        List<ProviderMessage> voiceHistory = SessionStore.loadSession(voiceId);

        assertEquals(typedHistory, voiceHistory,
                "the voice_input provenance line is audit-only — the history is identical");
        // And the audit line really is on disk (it is not silently dropped on write).
        assertTrue(SessionStore.readSessionEvents(voiceId).stream()
                        .anyMatch(RunEvent.VoiceInput.class::isInstance),
                "the voice_input line must persist for the trace tab / jq");
    }

    @Test
    void deleteSessionRemovesTheJsonlAndTheBlobFolder() throws IOException {
        String id = freshId();
        SessionStore store = new SessionStore(id);
        store.append(new RunEvent.RunStart("r1", "main", null, "hi", null, null, 1L));
        SessionStore.saveBlob(id, new byte[] {1, 2, 3}, "image/png");
        Path file = SessionStore.SESSIONS_DIR.resolve(id + ".jsonl");
        Path blobParent = SessionStore.SESSIONS_DIR.resolve(id);
        assertTrue(Files.exists(file));
        assertTrue(Files.isDirectory(blobParent));

        assertTrue(SessionStore.deleteSession(id), "an existing session reports true");

        assertTrue(Files.notExists(file), "the JSONL file is gone");
        assertTrue(Files.notExists(blobParent), "the blob folder is gone with it");
    }

    @Test
    void deleteSessionReportsFalseForAnUnknownId() throws IOException {
        assertEquals(false, SessionStore.deleteSession(freshId()));
    }

    @Test
    void deleteSessionRefusesTraversalIdsAndTouchesNothing() throws IOException {
        // A decoy OUTSIDE the sessions directory that a traversal id points at.
        Path decoy = SessionStore.SESSIONS_DIR.getParent().resolve("decoy.jsonl");
        Files.createDirectories(decoy.getParent());
        Files.writeString(decoy, "{}\n");
        try {
            assertEquals(false, SessionStore.deleteSession("../decoy"));
            assertEquals(false, SessionStore.deleteSession("a/b"));
            assertTrue(Files.exists(decoy), "the traversal target must survive");
        } finally {
            Files.deleteIfExists(decoy);
        }
    }
}
