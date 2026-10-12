package dev.spectroscope.core.goal;

import com.anthropic.errors.AnthropicServiceException;
import dev.spectroscope.core.provider.RetryPolicy;
import dev.spectroscope.core.provider.TransientProviderException;

import java.util.Locale;
import java.util.Optional;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * Card 504, criterion 4: the errors after which a goal clears itself. A run
 * that cannot reach its model again without the operator's hand (the context
 * is full, the key is refused, the account cannot pay, the model is gone) has
 * nothing left to continue toward. A transient error, a steering message and
 * the turn cap leave the goal as it is.
 *
 * <p>Read from the error the provider threw, through its cause chain: the
 * HTTP status where one is known (the Anthropic SDK's status code, or the
 * {@code HTTP nnn} the Ollama and OpenAI compatible providers put into their
 * message) and the words the backends use for each class. A transient error
 * (the provider's {@link TransientProviderException}, or a retryable status)
 * clears the goal only on a quota code; its other words do not count.</p>
 */
public final class UnrecoverableError {

    /** The context window is full. */
    public static final String CONTEXT_LIMIT = "context_limit";
    /** The key or the sign in is refused. */
    public static final String AUTHENTICATION = "authentication";
    /** The account cannot pay. */
    public static final String BILLING = "billing";
    /** The model is not there. */
    public static final String MODEL_UNAVAILABLE = "model_unavailable";

    private static final Pattern STATUS = Pattern.compile("\\bHTTP (\\d{3})\\b");

    private static final Pattern CONTEXT_WORDS = Pattern.compile("context[_ ]length|maximum context|context window"
            + "|prompt is too long|too many tokens|exceeds the context|context_length_exceeded");
    private static final Pattern QUOTA_CODES = Pattern.compile("insufficient_quota|credit_balance_exhausted"
            + "|exceeded your current quota");
    private static final Pattern BILLING_WORDS = Pattern.compile("insufficient_quota|exceeded your current quota"
            + "|credit[_ ]balance|billing|payment required|out of credits");
    private static final Pattern AUTH_WORDS = Pattern.compile("invalid[_ ]api[_ ]key|incorrect api key"
            + "|authentication|unauthori[sz]ed|permission_denied|api key not valid");
    private static final Pattern MODEL_WORDS = Pattern.compile("model_not_found|model .{0,80}not found"
            + "|no such model|model .{0,80}does not exist|model .{0,80}is not available|unknown model");

    private UnrecoverableError() {
    }

    /**
     * @param error what the run threw
     * @return the class, or empty for every other error
     */
    public static Optional<String> classify(Throwable error) {
        // Fix round 1: a transient error (marked so by its provider, or with a
        // retryable status anywhere in the chain) keeps the goal, whatever
        // loose words its text carries. Only a quota code clears it there:
        // OpenAI sends an exhausted quota as a 429.
        boolean transientError = false;
        for (Throwable at = error; at != null; at = next(at)) {
            Integer status = status(at, lower(at));
            if (at instanceof TransientProviderException || (status != null && RetryPolicy.retryableStatus(status))) {
                transientError = true;
            }
        }
        for (Throwable at = error; at != null; at = next(at)) {
            String text = lower(at);
            if (transientError) {
                if (QUOTA_CODES.matcher(text).find()) {
                    return Optional.of(BILLING);
                }
                continue;
            }
            if (CONTEXT_WORDS.matcher(text).find()) {
                return Optional.of(CONTEXT_LIMIT);
            }
            if (BILLING_WORDS.matcher(text).find()) {
                return Optional.of(BILLING);
            }
            if (MODEL_WORDS.matcher(text).find()) {
                return Optional.of(MODEL_UNAVAILABLE);
            }
            if (AUTH_WORDS.matcher(text).find()) {
                return Optional.of(AUTHENTICATION);
            }
            Integer status = status(at, text);
            if (status != null) {
                switch (status) {
                    case 401, 403 -> {
                        return Optional.of(AUTHENTICATION);
                    }
                    case 402 -> {
                        return Optional.of(BILLING);
                    }
                    case 413 -> {
                        return Optional.of(CONTEXT_LIMIT);
                    }
                    case 404 -> {
                        // The Messages endpoint is fixed, so an Anthropic 404 is
                        // the model (not_found_error); elsewhere the text names it.
                        if (at instanceof AnthropicServiceException || text.contains("model")) {
                            return Optional.of(MODEL_UNAVAILABLE);
                        }
                    }
                    default -> {
                    }
                }
            }
        }
        return Optional.empty();
    }

    private static Throwable next(Throwable at) {
        return at.getCause() == at ? null : at.getCause();
    }

    private static String lower(Throwable at) {
        return at.getMessage() == null ? "" : at.getMessage().toLowerCase(Locale.ROOT);
    }

    private static Integer status(Throwable at, String text) {
        if (at instanceof AnthropicServiceException service) {
            return service.statusCode();
        }
        Matcher m = STATUS.matcher(text.toUpperCase(Locale.ROOT));
        return m.find() ? Integer.valueOf(m.group(1)) : null;
    }
}
