package dev.spectroscope.core.session;

import com.fasterxml.jackson.databind.ObjectMapper;
import dev.spectroscope.core.events.RunEvent;
import dev.spectroscope.core.events.RunEvent.Attachment;
import dev.spectroscope.core.provider.LlmProvider.ImageContent;
import dev.spectroscope.core.provider.LlmProvider.ProviderContent;
import dev.spectroscope.core.provider.LlmProvider.ProviderMessage;
import dev.spectroscope.core.provider.LlmProvider.TextContent;
import dev.spectroscope.core.provider.LlmProvider.ToolCallContent;
import dev.spectroscope.core.provider.LlmProvider.ToolResultContent;

import java.io.IOException;
import java.io.UncheckedIOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardOpenOption;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.time.LocalDateTime;
import java.time.format.DateTimeFormatter;
import java.util.ArrayList;
import java.util.Base64;
import java.util.Comparator;
import java.util.HexFormat;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.UUID;
import java.util.stream.Stream;

/**
 * JSONL session store: every RunEvent is appended to ~/.spectro/sessions/&lt;id&gt;.jsonl
 * as one line, immediately. There is no "save" step and no open handle — the file
 * IS the state, which makes the store crash-safe by construction. The exact line
 * format is binding in JSONL-FORMAT.md.
 */
public final class SessionStore {

    /** ~/.spectro/sessions — every session file and blob folder lives directly here. */
    public static final Path SESSIONS_DIR =
            Path.of(System.getProperty("user.home"), ".spectro", "sessions");

    private static final String MAIN_AGENT_ID = "main"; // main agent per JSONL-FORMAT.md; children
    private static final DateTimeFormatter ID_STAMP = DateTimeFormatter.ofPattern("yyyyMMdd-HHmmss");

    private static final ObjectMapper JSON = new ObjectMapper();

    private final String id;
    private final Path file;

    /** New session with a freshly minted id (headless runs). */
    public SessionStore() {
        this(null);
    }

    /**
     * New session (generated id) or resume (given id).
     *
     * @param existingId the session id to append to, or null to mint a fresh one
     */
    public SessionStore(String existingId) {
        this.id = existingId != null ? existingId : newSessionId();
        this.file = SESSIONS_DIR.resolve(id + ".jsonl");
        try {
            Files.createDirectories(SESSIONS_DIR);
        } catch (IOException failure) {
            throw new UncheckedIOException("Cannot create " + SESSIONS_DIR, failure);
        }
    }

    /**
     * The canonical session id — sortable by start time, also the file's base name.
     *
     * @return the id this store appends under
     */
    public String id() {
        return id;
    }

    /**
     * The JSONL file all events go to.
     *
     * @return the absolute session file path (it may not exist before the first append)
     */
    public Path file() {
        return file;
    }

    /**
     * Appends one event as a single JSONL line. One write per event: crash-safe,
     * no flush problem, no open handle. Serialization failures are a programming
     * error (an event that is not JSON-serializable) and may throw.
     *
     * @param event the RunEvent to persist as the file's next line
     */
    public void append(RunEvent event) {
        try {
            String line = JSON.writeValueAsString(event) + "\n";
            Files.writeString(file, line, StandardCharsets.UTF_8,
                    StandardOpenOption.CREATE, StandardOpenOption.APPEND);
        } catch (IOException failure) {
            throw new UncheckedIOException("Cannot append to " + file, failure);
        }
    }

    /** yyyyMMdd-HHmmss-&lt;uuid8&gt;: sortable by start time, collision-free. */
    private static String newSessionId() {
        String stamp = LocalDateTime.now().format(ID_STAMP);
        String suffix = UUID.randomUUID().toString().substring(0, 8);
        return stamp + "-" + suffix;
    }

    // ---- blob store -------------------------------------------------
    // Binary data never enters a JSONL line (JSONL-FORMAT.md §7): the bytes live
    // content-addressed NEXT TO the session file, the event carries only the
    // reference (blobPath + sha256). Same hash = same image = one file.

    private static final List<String> SUPPORTED_MEDIA_TYPES =
            List.of("image/jpeg", "image/png", "image/webp", "image/gif");

    /**
     * Result of storing bytes in the blob store.
     *
     * @param blobPath the absolute file path the event will reference
     * @param sha256   the content hash — identity and file name at once
     */
    public record StoredBlob(String blobPath, String sha256) {}

    /**
     * Directory {@code ~/.spectro/sessions/<sessionId>/blobs} — created on demand.
     *
     * @param sessionId the owning session
     * @return the blob directory path (not necessarily existing yet)
     */
    public static Path blobsDir(String sessionId) {
        return SESSIONS_DIR.resolve(sessionId).resolve("blobs");
    }

    /**
     * Deletes a stored session for good: the JSONL file and, if present, the
     * session's blob folder (attachments). The id must resolve to a DIRECT
     * child of the sessions directory — a traversal id ("../x", "a/b") is
     * refused by returning {@code false}, nothing touched. Returns whether
     * the session file existed and was removed.
     *
     * @param id the session id as listed — never a path
     * @return true when the file existed and is gone now; false for traversal ids
     *         or unknown sessions
     */
    public static boolean deleteSession(String id) throws IOException {
        Path file = SESSIONS_DIR.resolve(id + ".jsonl").normalize();
        Path blobParent = SESSIONS_DIR.resolve(id).normalize();
        boolean insideStore = SESSIONS_DIR.equals(file.getParent())
                && SESSIONS_DIR.equals(blobParent.getParent());
        if (!insideStore) {
            return false;
        }
        boolean existed = Files.deleteIfExists(file);
        if (existed && Files.isDirectory(blobParent)) {
            try (Stream<Path> tree = Files.walk(blobParent)) {
                for (Path entry : tree.sorted(Comparator.reverseOrder()).toList()) {
                    Files.deleteIfExists(entry);
                }
            }
        }
        return existed;
    }

    /**
     * Stores bytes under {@code ~/.spectro/sessions/<id>/blobs/<sha256>}. Same hash =
     * same image = same file: existing blobs are not rewritten (deduplication).
     *
     * @param sessionId the session the blob belongs to
     * @param bytes     the raw image bytes
     * @param mediaType the IANA media type; only the supported image types pass
     * @return the stored blob's path and content hash
     */
    public static StoredBlob saveBlob(String sessionId, byte[] bytes, String mediaType) {
        if (!SUPPORTED_MEDIA_TYPES.contains(mediaType)) {
            throw new IllegalArgumentException("Unsupported media type: " + mediaType
                    + " (allowed: " + String.join(", ", SUPPORTED_MEDIA_TYPES) + ")");
        }
        String sha256 = sha256Hex(bytes);
        try {
            Path blobsDirectory = blobsDir(sessionId);
            Files.createDirectories(blobsDirectory);
            Path blobFile = blobsDirectory.resolve(sha256);
            if (!Files.exists(blobFile)) {
                Files.write(blobFile, bytes);
            }
            return new StoredBlob(blobFile.toString(), sha256);
        } catch (IOException failure) {
            throw new UncheckedIOException("Cannot write blob for session " + sessionId, failure);
        }
    }

    /**
     * Reads blob bytes back; used when attachment references become provider content.
     *
     * @param blobPath the absolute path stored in the attachment reference
     * @return the raw bytes
     */
    public static byte[] loadBlob(String blobPath) throws IOException {
        return Files.readAllBytes(Path.of(blobPath));
    }

    /**
     * Attachment references -&gt; provider content blocks (reloads the bytes). Used at
     * run start AND on resume — image blocks belong at the same position of the user
     * message, otherwise the model loses the reference.
     * A missing blob (deleted/moved) is skipped instead of thrown — the session stays
     * replayable (JSONL-FORMAT.md §7). The core does not log here (no System.out in
     * spectro-core); a frontend that wants to warn does so itself.
     *
     * @param attachments the attachment references from a run_start event
     * @return one ImageContent per readable blob, missing blobs skipped
     */
    public static List<ProviderContent> attachmentsToContent(List<Attachment> attachments) {
        List<ProviderContent> content = new ArrayList<>();
        for (Attachment attachment : attachments) {
            try {
                String dataBase64 = Base64.getEncoder().encodeToString(loadBlob(attachment.blobPath()));
                content.add(new ImageContent(attachment.mediaType(), dataBase64));
            } catch (IOException missingBlob) {
                // Blob missing: skip, so that resume/--resume does not crash.
            }
        }
        return content;
    }

    /**
     * Content hash for the blob store's addressing.
     *
     * @param bytes the payload to hash
     * @return the SHA-256 digest as lowercase hex
     */
    private static String sha256Hex(byte[] bytes) {
        try {
            byte[] digest = MessageDigest.getInstance("SHA-256").digest(bytes);
            return HexFormat.of().formatHex(digest);
        } catch (NoSuchAlgorithmException impossible) {
            // Every conforming JVM ships SHA-256 (Java security standard algorithms).
            throw new IllegalStateException("JVM without SHA-256", impossible);
        }
    }

    /**
     * Reads a session's events. A truncated last line (crash mid-write) is
     * discarded: each line is parsed in its own try/catch.
     *
     * @param id the session id whose file is read
     * @return all parseable events in file order
     */
    public static List<RunEvent> readSessionEvents(String id) throws IOException {
        Path path = SESSIONS_DIR.resolve(id + ".jsonl");
        List<RunEvent> events = new ArrayList<>();
        for (String line : Files.readString(path, StandardCharsets.UTF_8).split("\n")) {
            if (line.isBlank()) {
                continue;
            }
            try {
                events.add(JSON.readValue(line, RunEvent.class));
            } catch (IOException torn) {
                // Truncated trailing line after a crash — discard silently.
            }
        }
        return events;
    }

    /**
     * One row of the sessions overview.
     *
     * @param id          the session id
     * @param startedAt   the first run_start's timestamp (epoch millis)
     * @param firstPrompt the prompt that opened the session
     * @param tokens      input plus output tokens summed over the whole file
     * @param provider    the recorded provider label, "-" when absent
     */
    public record SessionInfo(String id, long startedAt, String firstPrompt, int tokens, String provider) {}

    /**
     * Overview over all sessions — a fold over the event files.
     *
     * @return one row per readable session, sorted by file name (= start time)
     */
    public static List<SessionInfo> listSessions() {
        if (!Files.isDirectory(SESSIONS_DIR)) {
            return List.of();
        }
        try (Stream<Path> files = Files.list(SESSIONS_DIR)) {
            return files
                    .filter(path -> path.getFileName().toString().endsWith(".jsonl"))
                    .sorted()
                    .map(SessionStore::describe)
                    .flatMap(Optional::stream)
                    .toList();
        } catch (IOException failure) {
            throw new UncheckedIOException("Cannot list " + SESSIONS_DIR, failure);
        }
    }

    /**
     * Folds one session file into its overview row; empty for unreadable/broken files.
     *
     * @param path the .jsonl file to summarize
     * @return the overview row, or empty when the file has no run_start or cannot be read
     */
    private static Optional<SessionInfo> describe(Path path) {
        String name = path.getFileName().toString();
        String id = name.substring(0, name.length() - ".jsonl".length());
        List<RunEvent> events;
        try {
            events = readSessionEvents(id);
        } catch (IOException unreadable) {
            return Optional.empty();
        }
        return events.stream()
                .filter(RunEvent.RunStart.class::isInstance)
                .map(RunEvent.RunStart.class::cast)
                .findFirst()
                .map(start -> new SessionInfo(
                        id,
                        start.ts(),
                        start.prompt(),
                        sumTokens(events),
                        Optional.ofNullable(start.provider()).orElse("-")));
    }

    /**
     * map-reduce over the usage events: input + output tokens of the whole file.
     *
     * @param events the session's full event list
     * @return the summed token count across every usage event
     */
    private static int sumTokens(List<RunEvent> events) {
        return events.stream()
                .filter(RunEvent.Usage.class::isInstance)
                .map(RunEvent.Usage.class::cast)
                .mapToInt(usage -> usage.inputTokens() + usage.outputTokens())
                .sum();
    }

    /**
     * Resume: reconstruct the provider history from events. Hard rule — every
     * tool_call needs its tool_result; orphaned calls (crash mid tool round) are
     * dropped, otherwise the API rejects the history. Only the main agent forms
     * the history (JSONL-FORMAT.md §5.2); child agents write into
     * the same file, but their result is already in the parent call's tool_result.
     *
     * @param id the session id to reconstruct
     * @return the provider-ready history, roles alternating
     */
    public static List<ProviderMessage> loadSession(String id) throws IOException {
        List<RunEvent> events = readSessionEvents(id);
        // Interop hardening: the main agent is found STRUCTURALLY — the first
        // run_start without a parentId — not by its name. This edition writes
        // "main", but the shared format only promises the structure, and the
        // format doc's own compact example ids ("a0") replay just as well.
        String mainAgentId = events.stream()
                .filter(RunEvent.RunStart.class::isInstance)
                .map(RunEvent.RunStart.class::cast)
                .filter(start -> start.parentId() == null)
                .map(RunEvent.RunStart::agentId)
                .findFirst()
                .orElse(MAIN_AGENT_ID);
        Reconstruction state = new Reconstruction();
        events.stream()
                .filter(event -> agentIdOf(event)
                        .map(mainAgentId::equals)
                        .orElse(true)) // events without an agentId pass through
                .forEach(state::consume);
        state.flush();
        return mergeAdjacentRoles(state.messages);
    }

    /**
     * Merges adjacent messages of the same role (the API requires alternation).
     *
     * @param messages the history, possibly with same-role neighbours
     * @return a new list where neighbouring same-role messages are combined into one
     */
    public static List<ProviderMessage> mergeAdjacentRoles(List<ProviderMessage> messages) {
        List<ProviderMessage> out = new ArrayList<>();
        for (ProviderMessage message : messages) {
            ProviderMessage last = out.isEmpty() ? null : out.getLast();
            if (last != null && last.role() == message.role()) {
                List<ProviderContent> combined = new ArrayList<>(last.content());
                combined.addAll(message.content());
                out.set(out.size() - 1, new ProviderMessage(last.role(), combined));
            } else {
                out.add(new ProviderMessage(message.role(), new ArrayList<>(message.content())));
            }
        }
        return out;
    }

    /**
     * The agentId an event carries, or empty for the types without one.
     *
     * @param event the event to inspect (an agent_message reports its sender)
     * @return the owning agent's id, or empty
     */
    private static Optional<String> agentIdOf(RunEvent event) {
        return Optional.ofNullable(switch (event) {
            case RunEvent.RunStart e -> e.agentId();
            case RunEvent.TurnStart e -> e.agentId();
            case RunEvent.TextDelta e -> e.agentId();
            case RunEvent.ThinkingDelta e -> e.agentId();
            case RunEvent.ToolCall e -> e.agentId();
            case RunEvent.PermissionRequest e -> e.agentId();
            case RunEvent.ToolResult e -> e.agentId();
            case RunEvent.AgentSpawn e -> e.agentId();
            case RunEvent.Compaction e -> e.agentId();
            case RunEvent.VoiceInput e -> e.agentId();
            case RunEvent.Usage e -> e.agentId();
            case RunEvent.ErrorEvent e -> e.agentId();
            case RunEvent.ImageGenerated e -> e.agentId();
            case RunEvent.ContextInfo e -> e.agentId();
            case RunEvent.AgentMessage e -> e.from(); // the emitting side owns the message
            case RunEvent.Plan e -> e.agentId();
            case RunEvent.PermissionDecision e -> null;
            case RunEvent.RunEnd e -> null;
        });
    }

    /**
     * Stateful fold: accumulates one turn's text and tool calls/results, then
     * flushes them as an assistant message (text + matched calls) followed by a
     * user message (the matched results).
     */
    private static final class Reconstruction {
        final List<ProviderMessage> messages = new ArrayList<>();
        final StringBuilder textBuffer = new StringBuilder();
        final List<ToolCallContent> calls = new ArrayList<>();
        final Map<String, ToolResultContent> results = new LinkedHashMap<>();

        /**
         * Folds one event into the running turn — flushing whenever the structure
         * says a turn boundary passed.
         *
         * @param event the next event in file order
         */
        void consume(RunEvent event) {
            switch (event) {
                case RunEvent.RunStart start -> {
                    flush();
                    // image blocks return at their old position — BEFORE the
                    // prompt text — or the model loses the reference on resume.
                    List<ProviderContent> content = new ArrayList<>();
                    if (start.attachments() != null) {
                        content.addAll(attachmentsToContent(start.attachments()));
                    }
                    content.add(new TextContent(start.prompt()));
                    messages.add(new ProviderMessage(ProviderMessage.Role.USER, List.copyOf(content)));
                }
                case RunEvent.TurnStart ignored -> flush(); // turn done: freeze the buffer
                case RunEvent.TextDelta delta -> {
                    // Interop hardening: text AFTER buffered tool results means a new
                    // turn structurally, even when a (foreign or abridged) file omits
                    // the turn_start — without the flush the closing answer would be
                    // merged into the previous assistant message, in the wrong order.
                    if (!results.isEmpty()) {
                        flush();
                    }
                    textBuffer.append(delta.text());
                }
                case RunEvent.ToolCall call ->
                        calls.add(new ToolCallContent(call.callId(), call.name(), call.input()));
                case RunEvent.ToolResult result ->
                        results.put(result.callId(),
                                new ToolResultContent(result.callId(), result.output(), result.isError()));
                default -> { } // usage, permission_*, compaction, run_end, error: nothing for the history
            }
        }

        /** Freezes the current turn. Orphaned calls (no matching result) are dropped. */
        void flush() {
            List<ProviderContent> assistant = new ArrayList<>();
            if (!textBuffer.toString().isBlank()) {
                assistant.add(new TextContent(textBuffer.toString()));
            }
            List<ToolCallContent> matched = calls.stream()
                    .filter(call -> results.containsKey(call.callId())) // orphaned calls dropped
                    .toList();
            assistant.addAll(matched);
            if (!assistant.isEmpty()) {
                messages.add(new ProviderMessage(ProviderMessage.Role.ASSISTANT, assistant));
            }
            if (!matched.isEmpty()) {
                List<ProviderContent> resultContent = matched.stream()
                        .map(call -> (ProviderContent) results.get(call.callId()))
                        .toList();
                messages.add(new ProviderMessage(ProviderMessage.Role.USER, resultContent));
            }
            textBuffer.setLength(0);
            calls.clear();
            results.clear();
        }
    }
}
