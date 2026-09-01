package dev.spectroscope.core.wire;

import com.fasterxml.jackson.annotation.JsonInclude;
import com.fasterxml.jackson.databind.ObjectMapper;
import dev.spectroscope.core.config.governing.Governs;
import dev.spectroscope.core.wire.LlmWireTap.WireOutcome;
import dev.spectroscope.core.wire.LlmWireTap.WireRequest;

import java.io.IOException;
import java.nio.ByteBuffer;
import java.nio.channels.FileChannel;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardOpenOption;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import java.util.function.Consumer;

/**
 * Writes the backend-to-LLM record of one session:
 * {@code ~/.spectro/llm-wire/&lt;session-id&gt;.llm.jsonl} — one {@code llm_request}
 * line per outgoing call (persisted at send time, so a crash mid-stream still
 * leaves the request on record) and one {@code llm_response} line when the
 * exchange closes. Bodies ride verbatim; that is the file's whole purpose.
 *
 * <p>Three honesty rules are enforced HERE, not left to callers: credential
 * header values never reach the file (names stay, values become a measured
 * redaction); past the byte ceiling the ledger stays complete but bodies are
 * dropped with an {@code omitted:"ceiling"} label and ONE {@code
 * llm_wire_truncated} marker says when; and every line is flushed as written,
 * because a recorder that buffers truth is a recorder that loses it.</p>
 *
 * <p>Thread-safe: parallel subagents share one recorder; appends serialize on
 * an internal lock, one exchange's two lines pair by {@code xid}, never by
 * position.</p>
 */
public final class LlmWireRecorder implements AutoCloseable {

    /** Serializer for the line records — NON_NULL keeps absent fields off the file. */
    private static final ObjectMapper JSON = new ObjectMapper()
            .setSerializationInclusion(JsonInclude.Include.NON_NULL);

    /** Header names whose VALUES are secrets — matched case-insensitively. */
    private static final Set<String> CREDENTIAL_HEADERS = Set.of(
            "authorization", "proxy-authorization", "x-api-key", "api-key",
            "x-goog-api-key", "cookie", "set-cookie");

    /** The default per-session byte ceiling: generous, but not unbounded. */
    @Governs(kind = Governs.Kind.LOOKS_SETTABLE, unit = Governs.Unit.BYTES)
    public static final long DEFAULT_CEILING_BYTES = 256L * 1024 * 1024;

    private final Path file;
    private final long ceilingBytes;
    private final Object lock = new Object();
    private long bytesWritten;
    private boolean seeded;                  // bytesWritten primed from the existing file
    private boolean truncated;               // latching: past the ceiling, every body is dropped
    private boolean closed;                  // a closed recorder writes nothing, ever again
    private volatile Consumer<ExchangeMeta> listener;
    private volatile Consumer<RequestMeta> requestListener;

    /**
     * A recorder onto an explicit file — the seam tests use.
     *
     * @param file         the sidecar file to append to (created lazily)
     * @param ceilingBytes the honest byte ceiling; past it bodies are omitted
     */
    public LlmWireRecorder(Path file, long ceilingBytes) {
        this.file = file;
        this.ceilingBytes = ceilingBytes;
    }

    /**
     * The production wiring: the sidecar of one session, next to (not inside)
     * the sessions directory — the session list scans every {@code *.jsonl}
     * under {@code sessions/} in full, and a wire file can be orders of
     * magnitude bigger than the session it records.
     *
     * @param sessionId the session file's basename (e.g. {@code 20260807-...-ab12cd34})
     * @return a recorder appending to {@code ~/.spectro/llm-wire/&lt;id&gt;.llm.jsonl}
     */
    public static LlmWireRecorder forSession(String sessionId) {
        return new LlmWireRecorder(fileFor(sessionId), DEFAULT_CEILING_BYTES);
    }

    /**
     * Where a session's wire file lives — shared with the read/download/delete
     * endpoints so the path rule exists once. An id is NEVER trusted as a path
     * (the same jail {@code SessionStore.sessionFile} keeps): anything but a
     * plain basename is refused, so a ws {@code ?resume=} id cannot steer the
     * sidecar into another directory.
     *
     * @param sessionId the session file's basename
     * @return the sidecar path under {@code ~/.spectro/llm-wire/}
     * @throws IllegalArgumentException when the id is not a plain basename
     */
    public static Path fileFor(String sessionId) {
        if (sessionId == null || !sessionId.matches("[A-Za-z0-9][A-Za-z0-9-]*")) {
            throw new IllegalArgumentException("not a session id: " + sessionId);
        }
        return Path.of(System.getProperty("user.home"), ".spectro", "llm-wire",
                sessionId + ".llm.jsonl");
    }

    /** @return the file this recorder appends to */
    public Path file() {
        return file;
    }

    /**
     * Registers the single metadata listener — the server sends a socket frame
     * per finished exchange from it. Bodies never travel through here.
     *
     * @param listener receives each exchange's metadata after its response line
     */
    public void onExchange(Consumer<ExchangeMeta> listener) {
        this.listener = listener;
    }

    /**
     * Registers the SEND-time listener (card 184 leg 2). Without it the socket
     * hears about an exchange exactly once, when the stream closes, so a request
     * that is still in flight is invisible and the finished row lands AFTER its
     * own text deltas — measured on a real turn: the POST left at 48.291, the
     * first token arrived at 50.035, the stream closed at 50.138, and only the
     * last of those reached the screen. The trace showed the answer above the
     * request.
     *
     * <p>Bodies never travel through here either: the sidecar keeps them and the
     * gated endpoint serves them on the gesture that asks.</p>
     *
     * @param listener receives each request's metadata once its line is written,
     *                 which is BEFORE the provider has answered anything
     */
    public void onRequest(Consumer<RequestMeta> listener) {
        this.requestListener = listener;
    }

    /**
     * Curries the session-level recorder with the calling agent's identity —
     * the provider itself knows neither agent, turn nor purpose.
     *
     * @param agentId the agent whose call this is
     * @param turn    the 1-based turn number, or null where no turn exists (stt)
     * @return the tap handed into one {@code ProviderRequest}, kind {@code chat}
     */
    public LlmWireTap bound(String agentId, Integer turn) {
        return bound(agentId, turn, "chat");
    }

    /**
     * The full binding — call sites that are not plain chat name themselves.
     *
     * @param agentId the agent whose call this is
     * @param turn    the 1-based turn number, or null where no turn exists
     * @param kind    what the call is for: chat | compaction | image | stt
     * @return the tap handed into one provider call
     */
    public LlmWireTap bound(String agentId, Integer turn, String kind) {
        return request -> new OpenExchange(agentId, turn, kind, request);
    }

    /** One announced request waiting for its close; buffers received lines. */
    private final class OpenExchange implements LlmWireTap.Exchange {

        private final String xid = UUID.randomUUID().toString();
        private final String agentId;
        private final Integer turn;
        private final String kind;
        private final WireRequest request;
        private final List<String> lines = new ArrayList<>();
        private boolean closed;

        private OpenExchange(String agentId, Integer turn, String kind, WireRequest request) {
            this.agentId = agentId;
            this.turn = turn;
            this.kind = kind;
            this.request = request;
            long bodyBytes = utf8Length(request.body());
            append(new RequestLine("llm_request", xid, agentId, turn, kind,
                    request.provider(), request.model(), request.transport(),
                    request.method(), request.url(), redact(request.headers()),
                    request.fidelity(), null, bodyBytes, null, request.ts()),
                    request.body(), bodyBytes);
            Consumer<RequestMeta> sent = requestListener;
            if (sent != null) {
                sent.accept(new RequestMeta(xid, agentId, turn, kind, request.provider(), request.model(),
                        request.transport(), request.method(), request.url(), bodyBytes,
                        request.fidelity(), request.ts()));
            }
        }

        @Override
        public void line(String rawLine) {
            synchronized (lines) {
                lines.add(rawLine);
            }
        }

        @Override
        public void end(WireOutcome outcome) {
            List<String> received;
            synchronized (lines) {
                if (closed) {
                    return; // an abort racing a natural close records once, not twice
                }
                closed = true;
                received = List.copyOf(lines);
            }
            long bodyBytes = outcome.body() != null
                    ? utf8Length(outcome.body())
                    : received.stream().mapToLong(LlmWireRecorder::utf8Length).sum();
            long durationMs = outcome.ts() - request.ts();
            append(new ResponseLine("llm_response", xid, agentId, turn, outcome.status(),
                    outcome.fidelity(), null, null,
                    outcome.body() != null ? null : received.size(),
                    bodyBytes, outcome.aborted() ? true : null, outcome.error(),
                    durationMs, null, outcome.ts()),
                    outcome.body(), received, bodyBytes);
            Consumer<ExchangeMeta> l = listener;
            if (l != null) {
                // transport travels with the summary now: it is the fact that
                // says WHICH WIRE this exchange used, and the trace column that
                // prints it was otherwise left inferring one from the provider.
                l.accept(new ExchangeMeta(xid, agentId, turn, kind,
                        request.provider(), request.model(), request.transport(), request.url(),
                        outcome.status(), utf8Length(request.body()), bodyBytes,
                        received.size(), outcome.aborted(), request.fidelity(),
                        durationMs, outcome.ts()));
            }
        }

        /** Serializes a request line, re-attaching the body only below the ceiling. */
        private void append(RequestLine line, String body, long bodyBytes) {
            synchronized (lock) {
                boolean fits = fits(bodyBytes);
                writeLine(fits ? line.withBody(body) : line.withOmitted("ceiling"));
            }
        }

        /** Serializes a response line, re-attaching body/lines only below the ceiling. */
        private void append(ResponseLine line, String body, List<String> received, long bodyBytes) {
            synchronized (lock) {
                boolean fits = fits(bodyBytes);
                if (!fits) {
                    writeLine(line.withOmitted("ceiling"));
                } else if (body != null) {
                    writeLine(line.withBody(body));
                } else {
                    writeLine(line.withLines(received));
                }
            }
        }
    }

    /**
     * Whether a payload of this size still fits under the ceiling. LATCHING:
     * the first miss writes the single truncation marker and every later body
     * is dropped too — the marker means "bodies stop here", exactly as the
     * class doc promises. Caller holds the lock.
     */
    private boolean fits(long payloadBytes) {
        seedIfNeeded();
        if (truncated) {
            return false;
        }
        if (bytesWritten + payloadBytes <= ceilingBytes) {
            return true;
        }
        truncated = true;
        writeLine(new TruncatedLine("llm_wire_truncated", bytesWritten, ceilingBytes,
                System.currentTimeMillis()));
        return false;
    }

    /**
     * Primes the byte count from a file that already exists — a resumed session
     * (or the shared stt day file) must not get a fresh ceiling allowance per
     * recorder instance. A file already past the ceiling latches truncation
     * WITHOUT a second marker: the one that crossed wrote it. Caller holds the lock.
     */
    private void seedIfNeeded() {
        if (seeded) {
            return;
        }
        seeded = true;
        try {
            if (Files.exists(file)) {
                bytesWritten = Files.size(file);
                truncated = bytesWritten >= ceilingBytes;
            }
        } catch (IOException unreadable) {
            reportWriteFailureOnce(unreadable);
        }
    }

    /**
     * Serializes one record and appends it as ONE atomic write. No handle is
     * held between lines: each append opens the file with {@code O_APPEND},
     * writes the whole line in a single channel write and closes — so two
     * recorders on the SAME file (the stt day file, a doubly-resumed session)
     * cannot interleave fragments mid-line, and {@code close()} has nothing to
     * leak. The pattern {@code SessionStore.append} already trusts. Caller
     * holds the lock.
     */
    private void writeLine(Object record) {
        if (closed) {
            // A late end() after close (tab closed mid-generation) must not
            // resurrect the file — the truth it would add is one response line;
            // the file it could recreate is one the user may just have deleted.
            reportWriteFailureOnce(new IOException("recording after close dropped"));
            return;
        }
        try {
            seedIfNeeded();
            Files.createDirectories(file.getParent());
            byte[] line = (JSON.writeValueAsString(record) + "\n")
                    .getBytes(StandardCharsets.UTF_8);
            try (FileChannel channel = FileChannel.open(file, StandardOpenOption.CREATE,
                    StandardOpenOption.WRITE, StandardOpenOption.APPEND)) {
                channel.write(ByteBuffer.wrap(line));
            }
            bytesWritten += line.length;
        } catch (IOException failure) {
            // The wire record is an additive mirror: it must never kill the run.
            // But it also must not fail silently forever — surface once via stderr.
            reportWriteFailureOnce(failure);
        }
    }

    private boolean writeFailureReported;

    /** One stderr line for the first failure; silence after — never a dead run. */
    private void reportWriteFailureOnce(IOException failure) {
        if (!writeFailureReported) {
            writeFailureReported = true;
            System.err.println("spectroscope: llm-wire recording failed: " + failure);
        }
    }

    @Override
    public void close() {
        synchronized (lock) {
            closed = true; // per-line appends hold no handle; the flag is the whole close
        }
    }

    /**
     * Replaces credential header VALUES with a measured redaction; every other
     * header passes through. Sorted map so the file is deterministic.
     *
     * @param headers the headers as the provider set them; null becomes absent
     * @return the redacted copy, or null when there were none
     */
    static Map<String, String> redact(Map<String, String> headers) {
        if (headers == null || headers.isEmpty()) {
            return null;
        }
        Map<String, String> out = new LinkedHashMap<>();
        headers.entrySet().stream()
                .sorted(Map.Entry.comparingByKey())
                .forEach(entry -> out.put(entry.getKey(),
                        CREDENTIAL_HEADERS.contains(entry.getKey().toLowerCase(Locale.ROOT))
                                ? "REDACTED(" + entry.getValue().length() + " chars)"
                                : entry.getValue()));
        return out;
    }

    private static long utf8Length(String s) {
        return s == null ? 0 : s.getBytes(StandardCharsets.UTF_8).length;
    }

    /**
     * What the server's live frame carries: everything ABOUT the exchange,
     * nothing OF it — bodies stay on disk and load on demand.
     *
     * @param xid           pairs the frame with the file's two lines
     * @param agentId       the calling agent
     * @param turn          the 1-based turn, null where none exists
     * @param kind          chat | compaction | image | stt
     * @param provider      the backend label
     * @param model         the model id the request named
     * @param url           the full request URL
     * @param status        the HTTP status, null when the connection never answered
     * @param requestBytes  UTF-8 size of the request body
     * @param responseBytes UTF-8 size of the response body or summed lines
     * @param responseLines how many stream lines were received
     * @param aborted       true when a cancel tore the stream down
     * @param fidelity      the request record's fidelity label
     * @param durationMs    send-to-close wall clock
     * @param ts            epoch millis at close time
     */
    /** What is known the moment a request leaves, which is everything except
     *  how it went. No status, no duration, no response size: those are facts
     *  that do not exist yet, and a zero in their place would be a claim. */
    public record RequestMeta(String xid, String agentId, Integer turn, String kind,
                              String provider, String model, String transport,
                              String method, String url, long requestBytes,
                              String fidelity, long ts) {}

    public record ExchangeMeta(String xid, String agentId, Integer turn, String kind,
                               String provider, String model, String transport, String url,
                               Integer status, long requestBytes, long responseBytes,
                               int responseLines, boolean aborted, String fidelity,
                               long durationMs, long ts) {}

    // ---- line records (the file format) ------------------------------------

    /** The {@code llm_request} line. Body is attached last so ceiling handling stays in one place. */
    @JsonInclude(JsonInclude.Include.NON_NULL)
    private record RequestLine(String type, String xid, String agentId, Integer turn,
                               String kind, String provider, String model, String transport,
                               String method, String url, Map<String, String> headers,
                               String fidelity, String body, Long bodyBytes, String omitted,
                               long ts) {
        RequestLine withBody(String body) {
            return new RequestLine(type, xid, agentId, turn, kind, provider, model, transport,
                    method, url, headers, fidelity, body, bodyBytes, omitted, ts);
        }

        RequestLine withOmitted(String reason) {
            return new RequestLine(type, xid, agentId, turn, kind, provider, model, transport,
                    method, url, headers, fidelity, null, bodyBytes, reason, ts);
        }
    }

    /** The {@code llm_response} line — {@code lines} for streams, {@code body} for single payloads. */
    @JsonInclude(JsonInclude.Include.NON_NULL)
    private record ResponseLine(String type, String xid, String agentId, Integer turn,
                                Integer status, String fidelity, List<String> lines,
                                String body, Integer lineCount, Long bodyBytes, Boolean aborted,
                                String error, Long durationMs, String omitted, long ts) {
        ResponseLine withBody(String attached) {
            return new ResponseLine(type, xid, agentId, turn, status, fidelity, null,
                    attached, null, bodyBytes, aborted, error, durationMs, omitted, ts);
        }

        ResponseLine withLines(List<String> received) {
            return new ResponseLine(type, xid, agentId, turn, status, fidelity, received,
                    null, null, bodyBytes, aborted, error, durationMs, omitted, ts);
        }

        ResponseLine withOmitted(String reason) {
            return new ResponseLine(type, xid, agentId, turn, status, fidelity, null,
                    null, lineCount, bodyBytes, aborted, error, durationMs, reason, ts);
        }
    }

    /** The single ceiling marker. */
    private record TruncatedLine(String type, long reachedBytes, long ceilingBytes, long ts) {}
}
