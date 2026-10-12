package dev.spectroscope.core.peer;

import com.fasterxml.jackson.annotation.JsonIgnoreProperties;
import com.fasterxml.jackson.annotation.JsonInclude;

import java.util.List;

/**
 * One process's record under {@code ~/.spectro/live/<pid>.json} (card 502
 * criterion 1, concept section Registry). One server process holds many
 * sessions, so the record carries a list.
 *
 * @param pid       the process id, also the file's stem
 * @param procStart the process start instant, ISO 8601 to the millisecond; the liveness token
 * @param startedAt when the face registered, epoch millis
 * @param face      {@code server}, {@code repl}, {@code headless}, {@code cron} or {@code node}
 * @param version   the product version
 * @param protocol  the messaging protocol version
 * @param features  optional capabilities, such as {@code notify_idle}
 * @param socket    the absolute path of the process's inbox socket
 * @param accepting false when this face refuses every inbound message
 * @param sessions  the sessions this process hosts
 */
@JsonInclude(JsonInclude.Include.NON_NULL)
@JsonIgnoreProperties(ignoreUnknown = true)
public record LiveRecord(long pid, String procStart, long startedAt, String face, String version,
                         int protocol, List<String> features, String socket, Boolean accepting,
                         List<Session> sessions) {

    /** Normalises the lists. */
    public LiveRecord {
        features = features == null ? List.of() : List.copyOf(features);
        sessions = sessions == null ? List.of() : List.copyOf(sessions);
    }

    /** @param next the sessions now @return a copy carrying them */
    public LiveRecord withSessions(List<Session> next) {
        return new LiveRecord(pid, procStart, startedAt, face, version, protocol, features, socket, accepting,
                next);
    }

    /**
     * One hosted session.
     *
     * @param id         the session id
     * @param name       the name peers address it by
     * @param nameSource {@code derived} or {@code title}
     * @param cwd        the session's folder
     * @param status     {@code busy}, {@code idle} or {@code waiting}
     * @param statusLine what the harness knows the session is doing, without a model call
     * @param turn       the turn of the running run, or null
     * @param mode       the permission mode
     * @param since      when the session became live here, epoch millis
     * @param updatedAt  when this row last changed, epoch millis
     */
    @JsonInclude(JsonInclude.Include.NON_NULL)
    @JsonIgnoreProperties(ignoreUnknown = true)
    public record Session(String id, String name, String nameSource, String cwd, String status,
                          String statusLine, Integer turn, String mode, Long since, Long updatedAt) {
    }
}
