package dev.spectroscope.server.providers;

import dev.spectroscope.core.config.SpectroConfig;
import dev.spectroscope.core.local.LocalModel;

import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.function.LongSupplier;

/**
 * Which providers are configured and which answer, for every surface that
 * asks. Presence (credential, model file, address) is recomputed on every
 * read; the last check result is the only stored thing, and it is keyed by a
 * signature of the inputs it was measured under, so a changed address or a
 * removed key never shows a stale answer.
 */
public final class ProviderRegistry {

    /** How a provider's model list is read. Injected so tests never dial. */
    public interface Lister {
        /**
         * Reads one provider's model list.
         *
         * @param provider the provider name
         * @param c        the config the address and key come from
         * @return the outcome of one attempt
         */
        ListResult list(String provider, SpectroConfig c);
    }

    /** Stored per provider: the result and the inputs it was measured under. */
    record Stored(ListResult result, String signature, long checkedAt) {
    }

    /** Time to live of a stored result for a {@code local} provider. */
    public static final long LOCAL_TTL_MS = 30_000L;
    /** Time to live of a stored result for a {@code cloud} provider. */
    public static final long CLOUD_TTL_MS = 600_000L;

    /** The credential form of a provider that authenticates with an API key. */
    public static final String CREDENTIAL_KEY = "key";
    /** The credential form of a provider that authenticates with a sign-in (card 478). */
    public static final String CREDENTIAL_SIGNIN = "signin";

    private static volatile ProviderRegistry shared;

    /**
     * The process wide registry, built on the real listers and the wall clock.
     *
     * @return the one registry of this process
     */
    public static ProviderRegistry shared() {
        ProviderRegistry r = shared;
        if (r == null) {
            synchronized (ProviderRegistry.class) {
                r = shared;
                if (r == null) {
                    r = new ProviderRegistry(ProviderRegistry::realList, System::currentTimeMillis);
                    shared = r;
                }
            }
        }
        return r;
    }

    private final Lister lister;
    private final LongSupplier clock;
    private final Map<String, Stored> stored = new ConcurrentHashMap<>();

    /**
     * A registry on an injected lister and clock.
     *
     * @param lister how a model list is read
     * @param clock  epoch milliseconds
     */
    public ProviderRegistry(Lister lister, LongSupplier clock) {
        this.lister = lister;
        this.clock = clock;
    }

    /** The real wires, chosen by the same rule {@code SessionsController.modelWire} uses. */
    static ListResult realList(String provider, SpectroConfig c) {
        if ("anthropic".equals(provider)) {
            return ModelLists.anthropic(SpectroConfig.resolveApiKey("ANTHROPIC_API_KEY"));
        }
        if ("ollama".equals(provider)) {
            return ModelLists.ollama(c.endpointFor(provider));
        }
        String key = SpectroConfig.resolveApiKey(SpectroConfig.keyEnvFor(provider));
        return ModelLists.openAiCompat(provider, c.endpointFor(provider), key);
    }

    /**
     * {@code cloud}, {@code local} or {@code builtin}, from the config's own rules.
     *
     * @param provider the provider name
     * @param c        the config the address comes from
     * @return the kind word
     */
    public static String kindOf(String provider, SpectroConfig c) {
        if ("spectro-local".equals(provider)) {
            return "builtin";
        }
        if (SpectroConfig.keylessLocalServers().contains(provider)) {
            return "local";
        }
        String endpoint = endpointOrNull(provider, c);
        if (endpoint != null && SpectroConfig.isLocalEndpoint(endpoint)) {
            return "local";
        }
        return "cloud";
    }

    /**
     * How a provider authenticates: {@link #CREDENTIAL_KEY} for every provider
     * today. Card 478 brings the first {@link #CREDENTIAL_SIGNIN} provider.
     *
     * @param provider the provider name
     * @return the credential form
     */
    public static String credentialFormOf(String provider) {
        return CREDENTIAL_KEY;
    }

    /**
     * The state of a provider whose credential is missing.
     *
     * @param form the credential form
     * @return {@code needs-signin} for a sign-in, {@code needs-key} otherwise
     */
    public static String missingCredentialState(String form) {
        return CREDENTIAL_SIGNIN.equals(form) ? "needs-signin" : "needs-key";
    }

    /**
     * The {@code credential} word of a row.
     *
     * @param form    the credential form
     * @param present whether the credential is there
     * @return {@code signed-in} or {@code not-signed-in} for a sign-in, null for a key
     */
    public static String credentialWord(String form, boolean present) {
        if (!CREDENTIAL_SIGNIN.equals(form)) {
            return null;
        }
        return present ? "signed-in" : "not-signed-in";
    }

    static String endpointOrNull(String provider, SpectroConfig c) {
        if (SpectroConfig.presetEndpointFor(provider) == null) {
            return null;
        }
        return c.endpointFor(provider);
    }

    static boolean keyPresent(String provider) {
        String env = SpectroConfig.keyEnvFor(provider);
        return env != null && SpectroConfig.hasApiKey(env);
    }

    /** Whether the credential is there. For a sign-in provider card 478 supplies the answer. */
    static boolean credentialPresent(String provider) {
        return keyPresent(provider);
    }

    static String signature(String provider, SpectroConfig c) {
        boolean modelFile = "spectro-local".equals(provider) && LocalModel.anyPresent();
        return endpointOrNull(provider, c) + "|" + credentialPresent(provider) + "|" + modelFile;
    }

    /**
     * One row per known provider, sorted by name. Sends no request.
     *
     * @param c the config presence is read from
     * @return the rows
     */
    public List<ProviderRow> rows(SpectroConfig c) {
        List<ProviderRow> out = new ArrayList<>();
        for (String p : SpectroConfig.knownProviders().stream().sorted().toList()) {
            out.add(row(p, c));
        }
        return out;
    }

    /**
     * Drops the stored result of one provider.
     *
     * @param provider the provider name
     */
    public void invalidate(String provider) {
        stored.remove(provider);
    }

    /**
     * Runs the lister for one provider and stores the result. A provider that
     * is built in or misses its credential or model file is returned as it
     * reads, without a request. Task 3 bounds the call.
     *
     * @param provider the provider name
     * @param c        the config the address and key come from
     * @return the row after the check
     */
    public ProviderRow check(String provider, SpectroConfig c) {
        ProviderRow before = row(provider, c);
        if (!checkable(before)) {
            return before;
        }
        ListResult result = lister.list(provider, c);
        stored.put(provider, new Stored(result, signature(provider, c), clock.getAsLong()));
        return row(provider, c);
    }

    static boolean checkable(ProviderRow row) {
        return !"builtin".equals(row.kind())
                && !"needs-key".equals(row.state())
                && !"needs-signin".equals(row.state())
                && !"needs-download".equals(row.state());
    }

    ProviderRow row(String provider, SpectroConfig c) {
        String kind = kindOf(provider, c);
        String form = credentialFormOf(provider);
        boolean present = credentialPresent(provider);
        boolean key = CREDENTIAL_KEY.equals(form) && present;
        String credential = credentialWord(form, present);
        String endpoint = "cloud".equals(kind) ? null : endpointOrNull(provider, c);
        if ("builtin".equals(kind)) {
            String state = LocalModel.anyPresent() ? "configured" : "needs-download";
            return new ProviderRow(provider, kind, state, false, null, null, List.of(), false, null, 0L);
        }
        if ("cloud".equals(kind) && !present) {
            return new ProviderRow(provider, kind, missingCredentialState(form), false, credential, null,
                    List.of(), false, null, 0L);
        }
        Stored s = stored.get(provider);
        if (s == null) {
            return new ProviderRow(provider, kind, "configured", key, credential, endpoint, List.of(), false,
                    null, 0L);
        }
        boolean sameInputs = s.signature().equals(signature(provider, c));
        long ttl = "local".equals(kind) ? LOCAL_TTL_MS : CLOUD_TTL_MS;
        boolean fresh = clock.getAsLong() - s.checkedAt() <= ttl;
        if (!sameInputs || !fresh) {
            return new ProviderRow(provider, kind, "configured", key, credential, endpoint, List.of(), false,
                    null, sameInputs ? s.checkedAt() : 0L);
        }
        ListResult r = s.result();
        if (r.isOk()) {
            return new ProviderRow(provider, kind, "reachable", key, credential, endpoint, r.models(), r.live(),
                    null, s.checkedAt());
        }
        return new ProviderRow(provider, kind, "failed", key, credential, endpoint, List.of(), false,
                r.outcome(), s.checkedAt());
    }
}
