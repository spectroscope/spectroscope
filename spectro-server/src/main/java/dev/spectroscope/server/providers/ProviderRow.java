package dev.spectroscope.server.providers;

import java.util.List;

/**
 * One provider as the registry sees it. {@code kind} is {@code cloud},
 * {@code local} or {@code builtin}; {@code state} is {@code needs-key},
 * {@code needs-signin}, {@code needs-download}, {@code configured},
 * {@code reachable} or {@code failed}. {@code keyPresent} is a boolean, never
 * a value. {@code credential} is null for a keyed provider and
 * {@code signed-in} or {@code not-signed-in} for a provider whose credential
 * is a sign-in. {@code endpoint} is null for a provider that owns no address.
 * {@code reason} is null unless the state is {@code failed}. {@code checkedAt}
 * is 0 when no check has ever run.
 *
 * @param id         the provider name
 * @param kind       cloud, local or builtin
 * @param state      the derived state word
 * @param keyPresent whether the provider's key is set, never its value
 * @param credential the sign-in word, or null for a keyed provider
 * @param endpoint   the address a check dials, or null
 * @param models     the models of the last answer, possibly none
 * @param live       true only when the models came from the provider
 * @param reason     the reason code of a failed check, or null
 * @param checkedAt  the time of the last check in epoch milliseconds, or 0
 */
public record ProviderRow(String id, String kind, String state, boolean keyPresent, String credential,
                          String endpoint, List<String> models, boolean live, String reason, long checkedAt) {
}
