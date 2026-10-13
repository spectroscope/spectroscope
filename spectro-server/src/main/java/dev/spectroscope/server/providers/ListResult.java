package dev.spectroscope.server.providers;

import java.util.List;

/**
 * One attempt to read a provider's model list. {@code outcome} is {@code ok}
 * or one reason code: {@code no-key}, {@code refused}, {@code timeout},
 * {@code rejected-key}, {@code http-<status>}, {@code bad-answer}. {@code live}
 * is true only when the models came from the provider, never from a curated
 * list. {@code endpoint} is the address that was dialled, so a failure can
 * name it. {@code httpStatus} is the status of an HTTP answer that failed
 * ({@code rejected-key} keeps whether it was 401 or 403, card 584), null for
 * an answer that arrived and for a failure without an HTTP answer.
 *
 * @param outcome    {@code ok} or the reason code
 * @param models     the model ids, possibly none
 * @param live       true only when the models came from the provider
 * @param endpoint   the address that was dialled
 * @param httpStatus the HTTP status of a failed answer, or null
 */
public record ListResult(String outcome, List<String> models, boolean live, String endpoint, Integer httpStatus) {

    /**
     * A result without an HTTP status, the shape before card 584.
     *
     * @param outcome  {@code ok} or the reason code
     * @param models   the model ids, possibly none
     * @param live     true only when the models came from the provider
     * @param endpoint the address that was dialled
     */
    public ListResult(String outcome, List<String> models, boolean live, String endpoint) {
        this(outcome, models, live, endpoint, null);
    }

    /**
     * A list that did not arrive because the provider answered with an HTTP failure.
     *
     * @param reason     the reason code
     * @param endpoint   the address that was dialled
     * @param httpStatus the status of the answer, or null when there was none
     * @return a result with no models, not live
     */
    public static ListResult failed(String reason, String endpoint, Integer httpStatus) {
        return new ListResult(reason, List.of(), false, endpoint, httpStatus);
    }

    /**
     * A list the provider answered with.
     *
     * @param models   the model ids the provider reported, possibly none
     * @param endpoint the address that was dialled
     * @return an {@code ok} result marked live
     */
    public static ListResult ok(List<String> models, String endpoint) {
        return new ListResult("ok", List.copyOf(models), true, endpoint);
    }

    /**
     * A list that did not arrive.
     *
     * @param reason   the reason code
     * @param endpoint the address that was dialled
     * @return a result with no models, not live
     */
    public static ListResult failed(String reason, String endpoint) {
        return new ListResult(reason, List.of(), false, endpoint);
    }

    /**
     * Whether the provider answered.
     *
     * @return true when {@code outcome} is {@code ok}
     */
    public boolean isOk() {
        return "ok".equals(outcome);
    }
}
