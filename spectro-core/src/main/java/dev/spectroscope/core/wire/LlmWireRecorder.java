package dev.spectroscope.core.wire;

import com.fasterxml.jackson.annotation.JsonInclude;
import com.fasterxml.jackson.databind.ObjectMapper;
import dev.spectroscope.core.wire.LlmWireTap.WireOutcome;
import dev.spectroscope.core.wire.LlmWireTap.WireRequest;

import java.io.BufferedWriter;
import java.io.IOException;
import java.io.UncheckedIOException;
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
    public static final long DEFAULT_CEILING_BYTES = 256L * 1024 * 1024;

    private final Path file;
    private final long ceilingBytes;
    private final Object lock = new Object();
    private BufferedWriter writer;           // opened lazily on the first exchange
    private long bytesWritten;
    private boolean truncated;
    private volatile Consumer<ExchangeMeta> listener;

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
     * endpoints so the path rule exists once.
     *
     * @param sessionId the session file's basename
     * @return the sidecar path under {@code ~/.spectro/llm-wire/}
     */
    public static Path fileFor(String sessionId) {
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
     * Curries the session-level recorder with the calling agent's identity —
     * the provider itself knows neither agent nor turn.
     *
     * @param agentId the agent whose call this is
     * @param turn    the 1-based turn number, or null where no turn exists (stt)
     * @return the tap handed into one {@code ProviderRequest}
     */
    public LlmWireTap bound(String agentId, Integer turn) {
        return request -> new OpenExchange(agentId, turn, request);
    }

    /** One announced request waiting for its close; buffers received lines. */
    private final class OpenExchange implements LlmWireTap.Exchange {

        private final String xid = UUID.randomUUID().toString();
        private final String agentId;
        private final Integer turn;
        private final WireRequest request;
        private final List<String> lines = new ArrayList<>();
        private boolean closed;

        private OpenExchange(String agentId, Integer turn, WireRequest request) {
            this.agentId = agentId;
            this.turn = turn;
            this.request = request;
            long bodyBytes = utf8Length(request.body());
            append(new RequestLine("llm_request", xid, agentId, turn, request.kind(),
                    request.provider(), request.model(), request.transport(),
                    request.method(), request.url(), redact(request.headers()),
                    request.fidelity(), null, bodyBytes, null, request.ts()),
                    request.body(), bodyBytes);
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
                l.accept(new ExchangeMeta(xid, agentId, turn, request.kind(),
                        request.provider(), request.model(), request.url(),
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
     * Whether a payload of this size still fits under the ceiling; the first
     * miss writes the single truncation marker. Caller holds the lock.
     */
    private boolean fits(long payloadBytes) {
        if (bytesWritten + payloadBytes <= ceilingBytes) {
            return true;
        }
        if (!truncated) {
            truncated = true;
            writeLine(new TruncatedLine("llm_wire_truncated", bytesWritten, ceilingBytes,
                    System.currentTimeMillis()));
        }
        return false;
    }

    /** Serializes one record and appends it, flushed. Caller holds the lock. */
    private void writeLine(Object record) {
        try {
            if (writer == null) {
                Files.createDirectories(file.getParent());
                writer = Files.newBufferedWriter(file, StandardCharsets.UTF_8,
                        StandardOpenOption.CREATE, StandardOpenOption.APPEND);
            }
            String json = JSON.writeValueAsString(record);
            writer.write(json);
            writer.write('\n');
            writer.flush();
            bytesWritten += utf8Length(json) + 1;
        } catch (IOException failure) {
            // The wire record is an additive mirror: it must never kill the run.
            // But it also must not fail silently forever — surface once via stderr.
            if (!writeFailureReported) {
                writeFailureReported = true;
                System.err.println("spectroscope: llm-wire recording failed: " + failure);
            }
        }
    }

    private boolean writeFailureReported;

    @Override
    public void close() {
        synchronized (lock) {
            if (writer != null) {
                try {
                    writer.close();
                } catch (IOException ignored) {
                    // flushed per line; a failing close loses nothing
                }
                writer = null;
            }
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
    public record ExchangeMeta(String xid, String agentId, Integer turn, String kind,
                               String provider, String model, String url, Integer status,
                               long requestBytes, long responseBytes, int responseLines,
                               boolean aborted, String fidelity, long durationMs, long ts) {}

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
