package dev.spectroscope.server.providers;

import java.util.List;

/**
 * One attempt to read a provider's model list. {@code outcome} is {@code ok}
 * or one reason code: {@code no-key}, {@code refused}, {@code timeout},
 * {@code rejected-key}, {@code http-<status>}, {@code bad-answer}. {@code live}
 * is true only when the models came from the provider, never from a curated
 * list. {@code endpoint} is the address that was dialled, so a failure can
 * name it.
 */
public record ListResult(String outcome, List<String> models, boolean live, String endpoint) {

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
