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
import java.nio.file.StandardCopyOption;
import java.nio.file.StandardOpenOption;
import java.nio.file.attribute.BasicFileAttributes;
import java.nio.file.attribute.FileTime;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.time.Instant;
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
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.atomic.AtomicBoolean;
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
        try {
            this.file = sessionFile(this.id);
        } catch (IOException outsideStore) {
            // A resume id is caller input (CLI --resume, the socket's ?resume=):
            // one that resolves outside the store is an argument error, not an
            // I/O failure — refused before anything is created or appended to.
            throw new IllegalArgumentException("Not a session id: " + id, outsideStore);
        }
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
     * Resolves a session id to its JSONL file — the ONE place an id becomes a
     * path. The id is caller input on three surfaces (REST path variable, the
     * websocket's {@code ?resume=}, the CLI's {@code --resume}), so the resolved
     * path must stay inside the store: normalized, under the sessions directory,
     * and a DIRECT child of it. Containment rather than an id-shape regex on
     * purpose — any file that really lives in the store stays addressable; the
     * strict shape check remains the HTTP edge's job.
     *
     * @param id the session id as the caller gave it — never trusted as a path
     * @return the contained session file path (it may not exist)
     * @throws IOException when the id resolves outside the sessions directory
     */
    public static Path sessionFile(String id) throws IOException {
        Path file = SESSIONS_DIR.resolve(id + ".jsonl").normalize();
        if (!file.startsWith(SESSIONS_DIR) || !SESSIONS_DIR.equals(file.getParent())) {
            throw new IOException("Not a session id: " + id);
        }
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
        Path file;
        try {
            file = sessionFile(id); // the shared jail: normalized, direct child
        } catch (IOException outsideStore) {
            return false;
        }
        Path blobParent = SESSIONS_DIR.resolve(id).normalize();
        if (!blobParent.startsWith(SESSIONS_DIR) || !SESSIONS_DIR.equals(blobParent.getParent())) {
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
     * How many event lines a stored session already holds.
     *
     * <p>Counted through {@link #readSessionEvents} on purpose, even though the
     * caller only wants a position: that reader skips blanks and discards a line
     * torn by a crash, and any other counting rule would disagree with it by one
     * on exactly those files. The client addresses events by their index in that
     * same list, so the two must agree or a receipt points at the wrong line.
     * A missing or unreadable file answers 0, because "start at the beginning"
     * is the safe wrong answer.</p>
     *
     * @param id the session id
     * @return the number of lines in that session's file, 0 when there is none
     */
    public static int eventCount(String id) {
        try {
            return readSessionEvents(id).size();
        } catch (IOException | RuntimeException unreadable) {
            return 0;
        }
    }

    /**
     * Reads a session's events. A truncated last line (crash mid-write) is
     * discarded: each line is parsed in its own try/catch. The id goes through
     * {@link #sessionFile(String)} first — a traversal id never reaches the
     * file system.
     *
     * @param id the session id whose file is read
     * @return all parseable events in file order
     * @throws IOException when the file cannot be read, or the id resolves
     *         outside the sessions directory
     */
    public static List<RunEvent> readSessionEvents(String id) throws IOException {
        Path path = sessionFile(id);
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
     * @param agentCount  distinct agents that ran (main + every subagent)
     * @param turnCount   top-level, main-agent turns — the steppable conversation
     * @param model       the model id the session opened with; null when the file
     *                    predates card 87 or the provider never named one
     * @param stopReason  how the LAST main run stopped, verbatim as the run_end
     *                    recorded it ("end_turn", "error", "aborted", "max_turns",
     *                    "max_tokens"); null when no run_end closed it. Deliberately
     *                    not folded into a verdict here — the wire carries the fact,
     *                    the reader decides what it means
     * @param gateCount   how often a tool call stopped at the permission gate
     * @param denyCount   how many of those stops ended in a refusal
     * @param endedAt     the last event's timestamp — with startedAt this is the
     *                    span the session covers, not the time it spent computing
     */
    public record SessionInfo(String id, long startedAt, String firstPrompt, int tokens,
            String provider, int agentCount, int turnCount,
            String model, String stopReason, int gateCount, int denyCount, long endedAt) {}

    /**
     * Overview over all sessions — a fold over the event files, memoized per file.
     *
     * @return one row per readable session, sorted by file name (= start time)
     */
    public static List<SessionInfo> listSessions() {
        if (!Files.isDirectory(SESSIONS_DIR)) {
            return List.of();
        }
        loadIndexOnce();
        try (Stream<Path> files = Files.list(SESSIONS_DIR)) {
            List<Path> stored = files
                    .filter(path -> path.getFileName().toString().endsWith(".jsonl"))
                    .sorted()
                    .toList();
            // The cache follows the directory instead of growing with it: a
            // deleted session would otherwise keep its row until the process
            // restarts, and the listing already knows every file, so bounding it
            // exactly costs one set copy. A concurrent list may evict a row
            // another thread has just folded; that race costs one extra fold,
            // never a wrong row.
            AtomicBoolean moved = new AtomicBoolean(FOLDED.keySet().retainAll(Set.copyOf(stored)));
            List<SessionInfo> rows = stored.stream()
                    .map(path -> describe(path, moved))
                    .flatMap(Optional::stream)
                    .toList();
            // Written only when this call actually changed something, so the
            // warm case — the common one — stays a pile of stats and no write
            // at all.
            if (moved.get()) {
                saveIndex();
            }
            return rows;
        } catch (IOException failure) {
            throw new UncheckedIOException("Cannot list " + SESSIONS_DIR, failure);
        }
    }

    /**
     * One session file's folded row, together with the file state it was folded
     * from.
     *
     * @param lastModified the file's modification time, read BEFORE its bytes
     * @param size         the file's length at that same moment
     * @param row          the folded row, or null when the file has no run_start
     *                     or could not be read — the negative answer is cached
     *                     too, or a broken file, and a session whose first line
     *                     is still a voice_input, would be re-read every call
     */
    private record FoldedRow(FileTime lastModified, long size, SessionInfo row) {}

    /** Whether this process has already tried to read the sidecar index. */
    private static final AtomicBoolean INDEX_LOADED = new AtomicBoolean(false);

    /**
     * Session file → its folded row. The twelve fields of a row are a pure
     * function of the file's bytes, and a session that has stopped never gains
     * another one, so reading and parsing every event of every session on every
     * list request bought nothing at a cost that grows with the whole store.
     * Only rows are held, never events: a row is a handful of fields, so the
     * cache stays proportional to the NUMBER of sessions, not to their size.
     * Concurrent because the REST worker, the socket and the CLI all list.
     */
    private static final Map<Path, FoldedRow> FOLDED = new ConcurrentHashMap<>();

    /**
     * The sidecar index — the folded rows written down so the NEXT process does
     * not pay for the whole history again.
     *
     * <p>Deliberately a sibling of the sessions directory rather than a file
     * inside it. Everything in there is a session or a session's blob folder,
     * and the delete path walks that directory by name; a cache file living
     * among the records would have to be excluded in every one of those places
     * forever.</p>
     *
     * @return the index path (it may not exist)
     */
    static Path sessionIndexFile() {
        return SESSIONS_DIR.resolveSibling("sessions-index.json");
    }

    /**
     * Drops the in-memory folds, leaving the sidecar index on disk — which is
     * exactly the state a restarted process starts in. The only way to exercise
     * the cold path without forking a JVM, so it exists for the tests and is
     * package-private for that reason.
     */
    static void forgetFoldedRows() {
        FOLDED.clear();
        INDEX_LOADED.set(false);
    }

    /**
     * Folds one session file into its overview row, reusing the previous fold
     * while the file's modification time and length are both unchanged.
     *
     * <p>The order of the two reads is the whole safety argument, and it is the
     * opposite of the obvious one. The metadata is read BEFORE the bytes, and
     * the fold is stored under THAT metadata. An append landing between the two
     * then produces a row FRESHER than its key, which the next call sees as a
     * mismatch and re-folds. Reading the bytes first and stamping them with the
     * metadata afterwards would cache a row STALER than its key — and since that
     * key already describes the file's current state, nothing could ever
     * invalidate it: a running session would freeze on the sidebar one event
     * short, permanently if that event was its last.</p>
     *
     * <p>Both halves of the key earn their place. An appended file always
     * changes length, which is what covers the session that is still being
     * written to; the modification time covers a file replaced in place — a
     * hand-edit, a restored backup — which length alone would miss. What the
     * pair cannot see is an in-place rewrite to exactly the same length inside
     * one modification-time tick, and no writer here can produce one: every
     * event goes through {@link #append(RunEvent)}, which only adds bytes.</p>
     *
     * @param path the .jsonl file to summarize
     * @return the overview row, or empty when the file has no run_start or cannot be read
     */
    private static Optional<SessionInfo> describe(Path path, AtomicBoolean moved) {
        BasicFileAttributes stamp;
        try {
            // ONE stat for both halves of the key, so length and time are a
            // consistent snapshot rather than two reads straddling an append.
            stamp = Files.readAttributes(path, BasicFileAttributes.class);
        } catch (IOException vanished) {
            // Deleted between the listing and here: fold anyway (it fails the
            // same way) and cache nothing about a file that is not there.
            return fold(path);
        }
        FoldedRow cached = FOLDED.get(path);
        if (cached != null
                && cached.size() == stamp.size()
                && cached.lastModified().equals(stamp.lastModifiedTime())) {
            return Optional.ofNullable(cached.row());
        }
        Optional<SessionInfo> row = fold(path);
        FOLDED.put(path, new FoldedRow(stamp.lastModifiedTime(), stamp.size(), row.orElse(null)));
        moved.set(true);
        return row;
    }

    /**
     * One line of the sidecar index: a folded row plus the file state it was
     * folded from, in a shape that survives a JSON round trip.
     *
     * <p>The modification time travels as an ISO-8601 instant rather than
     * milliseconds on purpose. APFS and ext4 both keep nanoseconds, and a key
     * truncated to the millisecond can never equal the stamp a later
     * {@code readAttributes} reports — the index would load, match nothing, and
     * quietly cost a full fold anyway while looking like it worked.</p>
     *
     * @param name         the session file's name inside the sessions directory
     * @param lastModified the modification time the row was folded under
     * @param size         the file length at that same moment
     * @param row          the folded row, or null for a file with no run_start
     */
    private record IndexEntry(String name, String lastModified, long size, SessionInfo row) {}

    /**
     * Seeds the in-memory folds from the sidecar index, once per process.
     *
     * <p>This is the only part of the cache that survives a restart, and it is
     * what keeps a cold start from re-reading the whole history. It seeds
     * rather than answers: every loaded row still goes through
     * {@link #describe} and still has to match the file's current stamp, so an
     * index written before the last three sessions grew is not a source of
     * stale rows — it is a source of rows that lose.</p>
     *
     * <p>Every failure mode ends the same way, silently: no file, half a file,
     * an older shape. The index is a cache and the JSONL files are the record,
     * so the worst an unusable index may cost is the fold it was meant to
     * save.</p>
     */
    private static void loadIndexOnce() {
        if (!INDEX_LOADED.compareAndSet(false, true)) {
            return;
        }
        List<IndexEntry> entries;
        try {
            entries = JSON.readValue(Files.readAllBytes(sessionIndexFile()),
                    JSON.getTypeFactory().constructCollectionType(List.class, IndexEntry.class));
        } catch (IOException | RuntimeException unusable) {
            return;
        }
        for (IndexEntry entry : entries) {
            Path path;
            try {
                path = SESSIONS_DIR.resolve(entry.name()).normalize();
                if (!SESSIONS_DIR.equals(path.getParent())) {
                    continue; // a name that walks out of the store is not a session
                }
                // putIfAbsent, never put: a row this process folded itself is
                // newer than anything on disk and must not lose to it.
                FOLDED.putIfAbsent(path, new FoldedRow(
                        FileTime.from(Instant.parse(entry.lastModified())), entry.size(), entry.row()));
            } catch (RuntimeException malformed) {
                // One bad entry costs one fold, not the whole index.
            }
        }
    }

    /**
     * Writes the folded rows down for the next process.
     *
     * <p>Through a temporary file and an atomic move, because two spectro
     * processes share one home: a reader must see either the old index or the
     * new one, never half of either. Losing the race only costs the losing
     * process's newest rows, which the next fold recomputes.</p>
     *
     * <p>An unwritable home is not an error here. The index buys speed and
     * nothing else, so a store on read-only media lists exactly as it always
     * did, slowly.</p>
     */
    private static void saveIndex() {
        List<IndexEntry> entries = new ArrayList<>(FOLDED.size());
        FOLDED.forEach((path, folded) -> entries.add(new IndexEntry(
                path.getFileName().toString(),
                folded.lastModified().toInstant().toString(),
                folded.size(),
                folded.row())));
        Path index = sessionIndexFile();
        Path scratch = null;
        try {
            scratch = Files.createTempFile(index.getParent(), "sessions-index", ".tmp");
            Files.write(scratch, JSON.writeValueAsBytes(entries));
            Files.move(scratch, index, StandardCopyOption.REPLACE_EXISTING,
                    StandardCopyOption.ATOMIC_MOVE);
        } catch (IOException | RuntimeException notWritten) {
            if (scratch != null) {
                try {
                    Files.deleteIfExists(scratch);
                } catch (IOException leftBehind) {
                    // A stray temp file is not worth failing a listing over.
                }
            }
        }
    }

    /**
     * Reads and folds one session file; empty for unreadable/broken files.
     *
     * @param path the .jsonl file to summarize
     * @return the overview row, or empty when the file has no run_start or cannot be read
     */
    private static Optional<SessionInfo> fold(Path path) {
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
                        Optional.ofNullable(start.provider()).orElse("-"),
                        countAgents(events),
                        countMainTurns(events),
                        start.model(),
                        lastMainStopReason(events),
                        countGateStops(events),
                        countDenials(events),
                        events.isEmpty() ? start.ts() : events.getLast().ts()));
    }

    /**
     * How the session ended: the stop reason of the LAST run the main agent
     * started.
     *
     * <p>Two rules earn their keep here. It reads the LAST main run because one
     * file holds one run_start per user prompt, and a session that failed on its
     * fourth question did not end cleanly just because its first one did. And it
     * matches run_ends by runId rather than taking the file's final one, because
     * a subagent's run_end also lands in this file — a failing worker inside a
     * finished fan-out is not the session failing.</p>
     *
     * @param events the session's full event list
     * @return the recorded stop reason, or null when no run_end closed that run
     *         (the process died mid-run, or the run is still going)
     */
    private static String lastMainStopReason(List<RunEvent> events) {
        String mainRunId = events.stream()
                .filter(RunEvent.RunStart.class::isInstance)
                .map(RunEvent.RunStart.class::cast)
                .filter(start -> start.parentId() == null)
                .reduce((first, second) -> second)
                .map(RunEvent.RunStart::runId)
                .orElse(null);
        if (mainRunId == null) {
            return null;
        }
        return events.stream()
                .filter(RunEvent.RunEnd.class::isInstance)
                .map(RunEvent.RunEnd.class::cast)
                .filter(end -> mainRunId.equals(end.runId()))
                .reduce((first, second) -> second)
                .map(RunEvent.RunEnd::stopReason)
                .orElse(null);
    }

    /** Tool calls that stopped at the permission gate — asked, not necessarily refused. */
    private static int countGateStops(List<RunEvent> events) {
        return (int) events.stream()
                .filter(RunEvent.PermissionRequest.class::isInstance)
                .count();
    }

    /** Of the gate stops, the ones the operator refused. */
    private static int countDenials(List<RunEvent> events) {
        return (int) events.stream()
                .filter(RunEvent.PermissionDecision.class::isInstance)
                .map(RunEvent.PermissionDecision.class::cast)
                .filter(decision -> !decision.allowed())
                .count();
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

    /** Distinct agents that ran in the file — one run_start per agent (the main
     *  agent and every subagent write into the same session file). */
    private static int countAgents(List<RunEvent> events) {
        return (int) events.stream()
                .filter(RunEvent.RunStart.class::isInstance)
                .map(RunEvent.RunStart.class::cast)
                .map(RunEvent.RunStart::agentId)
                .distinct()
                .count();
    }

    /** Top-level turns: turn_start fires once per agent per turn, so restrict to
     *  the main agent to count the STEPPABLE conversation turns, not subagent ones. */
    private static int countMainTurns(List<RunEvent> events) {
        String main = mainAgentId(events);
        return (int) events.stream()
                .filter(RunEvent.TurnStart.class::isInstance)
                .map(RunEvent.TurnStart.class::cast)
                .filter(turn -> main.equals(turn.agentId()))
                .count();
    }

    /** The main agent, found STRUCTURALLY — the first run_start without a parentId
     *  (JSONL-FORMAT.md §5.2), falling back to the conventional id. */
    private static String mainAgentId(List<RunEvent> events) {
        return events.stream()
                .filter(RunEvent.RunStart.class::isInstance)
                .map(RunEvent.RunStart.class::cast)
                .filter(start -> start.parentId() == null)
                .map(RunEvent.RunStart::agentId)
                .findFirst()
                .orElse(MAIN_AGENT_ID);
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
        // Interop hardening: the main agent is found STRUCTURALLY (first run_start
        // without a parentId), not by its name — see mainAgentId(). This edition
        // writes "main", but the shared format only promises the structure.
        String mainAgentId = mainAgentId(events);
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
            case RunEvent.LlmExchange e -> e.agentId();
            case RunEvent.BrowserAction e -> e.agentId();
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
