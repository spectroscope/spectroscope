package dev.spectroscope.core.wire;

import com.fasterxml.jackson.annotation.JsonInclude;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ArrayNode;
import com.fasterxml.jackson.databind.node.ObjectNode;
import dev.spectroscope.core.config.governing.Governs;
import dev.spectroscope.core.graph.Redaction;

import java.io.IOException;
import java.nio.ByteBuffer;
import java.nio.channels.FileChannel;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardOpenOption;
import java.util.Iterator;
import java.util.Map;
import java.util.UUID;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * Writes the browser record of one session (card 204):
 * {@code ~/.spectro/browser-wire/&lt;session-id&gt;.browser.jsonl} — one
 * {@code browser_call} line the moment a browser tool is entered, one
 * {@code browser_result} line when it answers, paired by {@code cid}.
 *
 * <p>The shape is the llm-wire's, deliberately: a sidecar beside the session
 * rather than a change to the byte-frozen RunEvent wire, the call persisted
 * before its outcome exists so a hung navigate is still on record, every line
 * flushed as it is written, and a latching ceiling that drops text while keeping
 * the ledger complete.
 *
 * <h2>What it may carry, which is the whole security argument</h2>
 *
 * <p>Only what the model already saw: the tool's arguments, the tool's result
 * string, the address the pane was on, and a REFERENCE to a screenshot blob.
 * Cookies, {@code localStorage}, the Chromium partition and the pane's own reply
 * object are not filtered here — they never cross {@link BrowserWireTap}, so
 * there is no code path along which they could arrive. Screenshot bytes travel
 * card 198's image path into the {@link dev.spectroscope.core.image.ImageStore}
 * and are named here by {@code blobPath} and {@code sha256}; that is what keeps
 * a run of a thousand actions a text file rather than tens of megabytes.
 *
 * <p>Every recorded string passes {@link Redaction}, the same rule table and the
 * same firing order the state sidecar uses. A string in which a rule fires is
 * replaced WHOLE by a marker naming the rule and a size BAND — not the exact
 * length, because an exact length is a small oracle and that is a finding
 * already open against the llm-wire (card 184) rather than one to repeat here.
 *
 * <h2>Epochs, because a session can outlive its browser</h2>
 *
 * <p>Closing a session retires its browser (card 218); resuming appends to the
 * same sidecar but opens a fresh browser with fresh cookies. Each recorder
 * claims the next epoch in the file on its FIRST call, so a replay can tell two
 * browsers apart instead of narrating two logins as one. A session that never
 * touches the browser claims nothing and creates no file.
 *
 * <p>Thread-safe: appends serialize on an internal lock, one call's two lines
 * pair by {@code cid} and never by position.
 */
public final class BrowserWireRecorder implements AutoCloseable, BrowserWireTap {

    /** Serializer for the line records — NON_NULL keeps absent fields off the file. */
    private static final ObjectMapper JSON = new ObjectMapper()
            .setSerializationInclusion(JsonInclude.Include.NON_NULL);

    /** Reads the epoch out of a recorded line without parsing the whole line. */
    private static final Pattern EPOCH = Pattern.compile("\"epoch\":(\\d+)");

    /**
     * The default per-session byte ceiling.
     *
     * <p>A quarter of the llm-wire's, and the smaller number is the point: this
     * file carries no bodies at all, so a run that reaches 64 MB of it is a run
     * whose browser trace has stopped being a trace. The measured traffic this
     * has to hold is 3,447 tool calls across 35 sessions (card 201's count of the
     * owner's own transcripts); at a few kilobytes per call that is single-digit
     * megabytes.
     */
    @Governs(kind = Governs.Kind.LOOKS_SETTABLE, unit = Governs.Unit.BYTES)
    public static final long DEFAULT_CEILING_BYTES = 64L * 1024 * 1024;

    private final Path file;
    private final long ceilingBytes;
    private final Object lock = new Object();
    private long bytesWritten;
    private int epoch;                       // 0 until the first call claims one
    private boolean truncated;               // latching: past the ceiling, text is dropped
    private boolean closed;
    private boolean writeFailureReported;

    /**
     * A recorder onto an explicit file — the seam tests use.
     *
     * @param file         the sidecar file to append to (created lazily)
     * @param ceilingBytes the honest byte ceiling; past it recorded text is dropped
     */
    public BrowserWireRecorder(Path file, long ceilingBytes) {
        this.file = file;
        this.ceilingBytes = ceilingBytes;
    }

    /**
     * The production wiring: the browser sidecar of one session, in its own
     * directory next to (not inside) {@code sessions/} for the same reason the
     * llm-wire is — the session list reads every {@code *.jsonl} under
     * {@code sessions/} in full.
     *
     * @param sessionId the session file's basename
     * @return a recorder appending to {@code ~/.spectro/browser-wire/&lt;id&gt;.browser.jsonl}
     */
    public static BrowserWireRecorder forSession(String sessionId) {
        return new BrowserWireRecorder(fileFor(sessionId), DEFAULT_CEILING_BYTES);
    }

    /**
     * Where a session's browser record lives — shared with the read endpoint so
     * the path rule exists once. An id is NEVER trusted as a path (the jail
     * {@code LlmWireRecorder.fileFor} and {@code SessionStore.sessionFile} both
     * keep): anything but a plain basename is refused, so no id from a URL, a
     * {@code ?resume=} parameter or a model can steer a read out of this folder.
     *
     * @param sessionId the session file's basename
     * @return the sidecar path under {@code ~/.spectro/browser-wire/}
     * @throws IllegalArgumentException when the id is not a plain basename
     */
    public static Path fileFor(String sessionId) {
        if (sessionId == null || !sessionId.matches("[A-Za-z0-9][A-Za-z0-9-]*")) {
            throw new IllegalArgumentException("not a session id: " + sessionId);
        }
        return Path.of(System.getProperty("user.home"), ".spectro", "browser-wire",
                sessionId + ".browser.jsonl");
    }

    /**
     * Where this recorder is appending.
     *
     * @return the file this recorder appends to
     */
    public Path file() {
        return file;
    }

    /**
     * Which browser of this session's life this recorder is writing for.
     *
     * @return the 1-based epoch, or 0 while no call has claimed one yet
     */
    public int epoch() {
        synchronized (lock) {
            return epoch;
        }
    }

    @Override
    public Call open(String tool, String agentId, String callId, JsonNode input, String pageUrl,
                     String actor) {
        String cid = UUID.randomUUID().toString();
        long started = System.currentTimeMillis();
        int claimed;
        synchronized (lock) {
            claimed = claimEpoch();
            CallLine line = new CallLine("browser_call", cid, claimed, agentId, callId, actor,
                    tool, null, null, redactString(pageUrl), redactMarker(pageUrl), started);
            JsonNode safeInput = redactNode(input);
            long payload = utf8Length(String.valueOf(safeInput));
            writeLine(fits(payload) ? line.withInput(safeInput) : line.withOmitted("ceiling"));
        }
        return new OpenCall(cid, claimed, started);
    }

    /** One announced call, holding its own image reference until it closes. */
    private final class OpenCall implements Call {

        private final String cid;
        private final int epoch;
        private final long started;
        private ImageRef image;
        private boolean ended;

        private OpenCall(String cid, int epoch, long started) {
            this.cid = cid;
            this.epoch = epoch;
            this.started = started;
        }

        @Override
        public String cid() {
            return cid;
        }

        @Override
        public int epoch() {
            return epoch;
        }

        @Override
        public void image(String mediaType, String blobPath, String sha256,
                          int width, int height, long bytes) {
            synchronized (this) {
                image = new ImageRef(mediaType, blobPath, sha256, width, height, bytes);
            }
        }

        @Override
        public String imageSha256() {
            synchronized (this) {
                return image == null ? null : image.sha256();
            }
        }

        @Override
        public void end(boolean ok, String result, String pageUrl) {
            ImageRef ref;
            synchronized (this) {
                if (ended) {
                    return; // a failure racing a natural close records once, not twice
                }
                ended = true;
                ref = image;
            }
            long now = System.currentTimeMillis();
            long resultBytes = utf8Length(result);
            ResultLine line = new ResultLine("browser_result", cid, epoch, ok, null, null,
                    redactString(pageUrl), redactMarker(pageUrl), ref, resultBytes,
                    null, now - started, now);
            synchronized (lock) {
                String safe = redactString(result);
                if (!fits(resultBytes)) {
                    writeLine(line.withOmitted("ceiling"));
                } else if (safe == null && result != null) {
                    writeLine(line.withRedacted(redactMarker(result)));
                } else {
                    writeLine(line.withResult(safe));
                }
            }
        }
    }

    // ---- the file --------------------------------------------------------- //

    /**
     * The epoch this recorder writes under, claimed on first use: one past the
     * highest already in the file, or 1 for a file that does not exist yet. The
     * claim also writes the {@code browser_open} marker, so a reader can see
     * where one browser's life begins without inferring it from a gap in time.
     * Caller holds the lock.
     *
     * @return the claimed epoch
     */
    private int claimEpoch() {
        if (epoch > 0) {
            return epoch;
        }
        int highest = 0;
        try {
            if (Files.isRegularFile(file)) {
                bytesWritten = Files.size(file);
                truncated = bytesWritten >= ceilingBytes;
                for (String line : Files.readAllLines(file, StandardCharsets.UTF_8)) {
                    Matcher found = EPOCH.matcher(line);
                    if (found.find()) {
                        highest = Math.max(highest, Integer.parseInt(found.group(1)));
                    }
                }
            }
        } catch (IOException | RuntimeException unreadable) {
            // An unreadable or half-written predecessor must not cost this run its
            // record. Worst case the epoch restarts, which the marker line says.
            reportWriteFailureOnce(new IOException("browser sidecar not re-readable", unreadable));
        }
        epoch = highest + 1;
        writeLine(new OpenLine("browser_open", epoch, System.currentTimeMillis()));
        return epoch;
    }

    /**
     * Whether a payload of this size still fits. LATCHING, like the llm-wire's:
     * the first miss writes the single marker and every later text is dropped
     * too. Caller holds the lock.
     *
     * @param payloadBytes the size of the text about to be attached
     * @return true while text may still be recorded
     */
    private boolean fits(long payloadBytes) {
        if (truncated) {
            return false;
        }
        if (bytesWritten + payloadBytes <= ceilingBytes) {
            return true;
        }
        truncated = true;
        writeLine(new TruncatedLine("browser_wire_truncated", bytesWritten, ceilingBytes,
                System.currentTimeMillis()));
        return false;
    }

    /**
     * Serializes one record and appends it as ONE atomic write, holding no handle
     * between lines — the pattern {@code LlmWireRecorder} and
     * {@code SessionStore.append} already trust, so two recorders on one file
     * cannot interleave fragments mid-line. Caller holds the lock.
     *
     * @param record the line record to serialize
     */
    private void writeLine(Object record) {
        if (closed) {
            reportWriteFailureOnce(new IOException("recording after close dropped"));
            return;
        }
        try {
            Path parent = file.getParent();
            if (parent != null) {
                Files.createDirectories(parent);
            }
            byte[] line = (JSON.writeValueAsString(record) + "\n").getBytes(StandardCharsets.UTF_8);
            try (FileChannel channel = FileChannel.open(file, StandardOpenOption.CREATE,
                    StandardOpenOption.WRITE, StandardOpenOption.APPEND)) {
                channel.write(ByteBuffer.wrap(line));
            }
            bytesWritten += line.length;
        } catch (IOException failure) {
            // The browser record is an additive mirror: it must never kill the run.
            reportWriteFailureOnce(failure);
        }
    }

    /** One stderr line for the first failure; silence after — never a dead run.
     *  @param failure what went wrong the first time */
    private void reportWriteFailureOnce(IOException failure) {
        if (!writeFailureReported) {
            writeFailureReported = true;
            System.err.println("spectroscope: browser-wire recording failed: " + failure);
        }
    }

    @Override
    public void close() {
        synchronized (lock) {
            closed = true; // per-line appends hold no handle; the flag is the whole close
        }
    }

    // ---- redaction -------------------------------------------------------- //

    /**
     * The recorded form of one string: itself when no rule fires, null when one
     * does — the caller then writes {@link #redactMarker} in a field of its own,
     * so a reader can tell a redacted value from an absent one.
     *
     * @param value the string as it was given, may be null
     * @return the safe string, or null when it must not be recorded
     */
    static String redactString(String value) {
        return value == null || Redaction.firstRule(value) != null ? null : value;
    }

    /**
     * The marker that stands where a redacted string stood: the rule that fired
     * and a size BAND. Never the exact length — that is the open finding on card
     * 184 and is not repeated here.
     *
     * @param value the string as it was given, may be null
     * @return the marker, or null when the string was safe or absent
     */
    static ObjectNode redactMarker(String value) {
        if (value == null) {
            return null;
        }
        String rule = Redaction.firstRule(value);
        if (rule == null) {
            return null;
        }
        return JSON.createObjectNode()
                .put("kind", "redacted")
                .put("rule", rule)
                .put("bytes", Redaction.bucket(value));
    }

    /**
     * The model's argument object with every credential-shaped string leaf
     * swapped for a marker. Walks arrays and nested objects, because a model can
     * put a URL anywhere the schema allows a string.
     *
     * @param node the arguments as the model wrote them, may be null
     * @return a safe copy, or null when there were no arguments
     */
    static JsonNode redactNode(JsonNode node) {
        if (node == null || node.isNull()) {
            return null;
        }
        if (node.isTextual()) {
            ObjectNode marker = redactMarker(node.asText());
            return marker == null ? node : marker;
        }
        if (node.isArray()) {
            ArrayNode out = JSON.createArrayNode();
            node.forEach(element -> out.add(redactNode(element)));
            return out;
        }
        if (node.isObject()) {
            ObjectNode out = JSON.createObjectNode();
            for (Iterator<Map.Entry<String, JsonNode>> fields = node.fields(); fields.hasNext(); ) {
                Map.Entry<String, JsonNode> field = fields.next();
                out.set(field.getKey(), redactNode(field.getValue()));
            }
            return out;
        }
        return node;
    }

    /**
     * The address as an EVENT may carry it: itself, or a short marker naming the
     * rule that fired.
     *
     * <p>The structured marker with its size band belongs in the sidecar, where a
     * reader can drill into it. A {@link dev.spectroscope.core.events.RunEvent} is
     * a public protocol three editions parse, and its {@code url} field is a
     * string — so the short form goes there, in brackets no address can wear.
     *
     * @param url the address as it was seen, may be null
     * @return the address, the bracketed marker, or null when there was none
     */
    public static String recordableUrl(String url) {
        String rule = url == null ? null : Redaction.firstRule(url);
        return rule == null ? url : "[redacted: " + rule + "]";
    }

    /** UTF-8 size of a string, 0 for null.
     *  @param s the string @return its byte length */
    private static long utf8Length(String s) {
        return s == null ? 0 : s.getBytes(StandardCharsets.UTF_8).length;
    }

    // ---- line records (the file format) ------------------------------------ //

    /** The {@code browser_open} marker: one browser's life begins here.
     *  @param type  the discriminator
     *  @param epoch the browser number within this session
     *  @param ts    epoch millis */
    private record OpenLine(String type, int epoch, long ts) {}

    /** A screenshot, by reference. No bytes, ever.
     *  @param mediaType the stored blob's IANA type
     *  @param blobPath  the reference into the store, relative to {@code ~/.spectro}
     *  @param sha256    the store's content hash
     *  @param width     the picture's width in pixels
     *  @param height    the picture's height in pixels
     *  @param bytes     the decoded size of the stored blob */
    @JsonInclude(JsonInclude.Include.NON_NULL)
    public record ImageRef(String mediaType, String blobPath, String sha256,
                           int width, int height, long bytes) {}

    /** The {@code browser_call} line. Input is attached last so ceiling handling
     *  stays in one place. {@code actor} is card 227's one additive field:
     *  {@code "operator"} for a human's own action, absent for an agent's —
     *  absent so an agent line keeps card 204's exact shape. */
    @JsonInclude(JsonInclude.Include.NON_NULL)
    private record CallLine(String type, String cid, int epoch, String agentId, String callId,
                            String actor, String tool, JsonNode input, String omitted,
                            String pageUrl, ObjectNode pageUrlRedacted, long ts) {
        CallLine withInput(JsonNode attached) {
            return new CallLine(type, cid, epoch, agentId, callId, actor, tool, attached,
                    omitted, pageUrl, pageUrlRedacted, ts);
        }

        CallLine withOmitted(String reason) {
            return new CallLine(type, cid, epoch, agentId, callId, actor, tool, null, reason,
                    pageUrl, pageUrlRedacted, ts);
        }
    }

    /** The {@code browser_result} line. */
    @JsonInclude(JsonInclude.Include.NON_NULL)
    private record ResultLine(String type, String cid, int epoch, boolean ok, String result,
                              ObjectNode resultRedacted, String pageUrl, ObjectNode pageUrlRedacted,
                              ImageRef image, long resultBytes, String omitted, long durationMs,
                              long ts) {
        ResultLine withResult(String attached) {
            return new ResultLine(type, cid, epoch, ok, attached, null, pageUrl, pageUrlRedacted,
                    image, resultBytes, omitted, durationMs, ts);
        }

        ResultLine withRedacted(ObjectNode marker) {
            return new ResultLine(type, cid, epoch, ok, null, marker, pageUrl, pageUrlRedacted,
                    image, resultBytes, omitted, durationMs, ts);
        }

        ResultLine withOmitted(String reason) {
            return new ResultLine(type, cid, epoch, ok, null, null, pageUrl, pageUrlRedacted,
                    image, resultBytes, reason, durationMs, ts);
        }
    }

    /** The single ceiling marker.
     *  @param type         the discriminator
     *  @param reachedBytes how much had been written when it fired
     *  @param ceilingBytes the ceiling it crossed
     *  @param ts           epoch millis */
    private record TruncatedLine(String type, long reachedBytes, long ceilingBytes, long ts) {}
}
