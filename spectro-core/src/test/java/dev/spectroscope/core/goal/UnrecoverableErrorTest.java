package dev.spectroscope.core.goal;

import com.anthropic.core.JsonValue;
import com.anthropic.core.http.Headers;
import com.anthropic.errors.AnthropicServiceException;
import com.anthropic.errors.BadRequestException;
import com.anthropic.errors.InternalServerException;
import com.anthropic.errors.NotFoundException;
import com.anthropic.errors.PermissionDeniedException;
import com.anthropic.errors.RateLimitException;
import com.anthropic.errors.UnauthorizedException;
import com.anthropic.errors.UnexpectedStatusCodeException;
import dev.spectroscope.core.provider.TransientProviderException;
import org.junit.jupiter.api.Test;

import java.util.Map;
import java.util.Optional;

import static org.junit.jupiter.api.Assertions.assertEquals;

/**
 * Card 504, criterion 4, fix round 1: the classes of {@link UnrecoverableError}
 * through each path the classifier reads: the backend's words, the
 * {@code HTTP nnn} the Ollama and OpenAI compatible providers write, and the
 * status of an Anthropic SDK exception. A transient error keeps the goal even
 * when its text carries one of the loose words; each such negative stands
 * beside a positive of the same words on a terminal error.
 *
 * <p>Formats checked on 2026-10-12 against the providers' error pages:
 * Anthropic 401 {@code authentication_error}, 402 {@code billing_error}, 403
 * {@code permission_error}, 404 {@code not_found_error}, 413
 * {@code request_too_large}; OpenAI 429 "Credit balance exhausted", code
 * {@code credit_balance_exhausted}.</p>
 */
class UnrecoverableErrorTest {

    private static final Optional<String> NONE = Optional.empty();

    private static Optional<String> of(String reason) {
        return Optional.of(reason);
    }

    private static Optional<String> classify(Throwable error) {
        return UnrecoverableError.classify(error);
    }

    private static JsonValue body(String type, String message) {
        return JsonValue.from(Map.of("type", "error", "error", Map.of("type", type, "message", message)));
    }

    private static Headers headers() {
        return Headers.builder().build();
    }

    // ── words ───────────────────────────────────────────────────────────

    @Test
    void theWordsOfEachClassClassifyOnATerminalError() {
        assertEquals(of(UnrecoverableError.CONTEXT_LIMIT),
                classify(new IllegalStateException("This model's maximum context length is 8192 tokens")));
        assertEquals(of(UnrecoverableError.AUTHENTICATION),
                classify(new IllegalStateException("Incorrect API key provided")));
        assertEquals(of(UnrecoverableError.BILLING),
                classify(new IllegalStateException("Your credit balance is too low to access the API")));
        assertEquals(of(UnrecoverableError.MODEL_UNAVAILABLE),
                classify(new IllegalStateException("model 'qwen9:404b' not found")));
    }

    @Test
    void anErrorWithoutAnyOfTheWordsOrAStatusIsNoClass() {
        assertEquals(NONE, classify(new IllegalStateException("socket closed")));
        assertEquals(NONE, classify(new IllegalStateException("HTTP 400: tool_choice is invalid")));
    }

    // ── HTTP nnn in the text ────────────────────────────────────────────

    @Test
    void theStatusInTheTextClassifiesWhereTheWordsAreMissing() {
        assertEquals(of(UnrecoverableError.AUTHENTICATION),
                classify(new IllegalStateException("OpenAI-compatible server HTTP 401")));
        assertEquals(of(UnrecoverableError.AUTHENTICATION),
                classify(new IllegalStateException("OpenAI-compatible server HTTP 403")));
        assertEquals(of(UnrecoverableError.BILLING),
                classify(new IllegalStateException("OpenAI-compatible server HTTP 402")));
        assertEquals(of(UnrecoverableError.CONTEXT_LIMIT),
                classify(new IllegalStateException("OpenAI-compatible server HTTP 413")));
        assertEquals(of(UnrecoverableError.MODEL_UNAVAILABLE),
                classify(new IllegalStateException("OpenAI-compatible server HTTP 404: {\"error\":\"model: m\"}")));
    }

    @Test
    void aFourOFourThatDoesNotNameAModelIsNoClass() {
        assertEquals(NONE, classify(new IllegalStateException("OpenAI-compatible server HTTP 404: no route")));
    }

    // ── an Anthropic SDK exception ──────────────────────────────────────

    @Test
    void theAnthropicStatusClassifiesEachReason() {
        assertEquals(of(UnrecoverableError.AUTHENTICATION), classify(UnauthorizedException.builder()
                .headers(headers()).body(body("authentication_error", "x")).build()));
        assertEquals(of(UnrecoverableError.AUTHENTICATION), classify(PermissionDeniedException.builder()
                .headers(headers()).body(body("permission_error", "x")).build()));
        assertEquals(of(UnrecoverableError.MODEL_UNAVAILABLE), classify(NotFoundException.builder()
                .headers(headers()).body(body("not_found_error", "The requested resource could not be found."))
                .build()), "the documented example names no model: the status decides");
        assertEquals(of(UnrecoverableError.BILLING), classify(UnexpectedStatusCodeException.builder()
                .statusCode(402).headers(headers()).body(body("billing_error", "x")).build()));
        assertEquals(of(UnrecoverableError.CONTEXT_LIMIT), classify(UnexpectedStatusCodeException.builder()
                .statusCode(413).headers(headers()).body(body("request_too_large", "x")).build()));
    }

    @Test
    void anAnthropicBadRequestClassifiesByItsWords() {
        AnthropicServiceException low = BadRequestException.builder().headers(headers())
                .body(body("invalid_request_error", "Your credit balance is too low")).build();
        assertEquals(of(UnrecoverableError.BILLING), classify(low));
        AnthropicServiceException other = BadRequestException.builder().headers(headers())
                .body(body("invalid_request_error", "tool_choice is invalid")).build();
        assertEquals(NONE, classify(other));
    }

    // ── a transient error keeps the goal ────────────────────────────────

    @Test
    void aTransientErrorWithALooseWordKeepsTheGoalWhereTheSameWordsOnATerminalErrorClearIt() {
        String billing = "Rate limit reached. See https://platform.example/account/billing for your plan";
        String auth = "authentication service unavailable, try again";
        assertEquals(of(UnrecoverableError.BILLING), classify(new IllegalStateException(billing)),
                "premise: the words alone classify");
        assertEquals(of(UnrecoverableError.AUTHENTICATION), classify(new IllegalStateException(auth)),
                "premise: the words alone classify");
        assertEquals(NONE, classify(new TransientProviderException("OpenAI-compatible server HTTP 429: " + billing)));
        assertEquals(NONE, classify(new TransientProviderException("Ollama HTTP 503: " + auth)));
        assertEquals(NONE, classify(new RuntimeException("retries exhausted",
                new TransientProviderException("HTTP 503: unauthorized upstream"))),
                "a transient cause deeper in the chain counts");
        assertEquals(NONE, classify(new IllegalStateException("HTTP 503: " + auth)),
                "a retryable status in the text counts as transient");
    }

    @Test
    void anAnthropicRateLimitOrServerErrorWithALooseWordKeepsTheGoal() {
        assertEquals(NONE, classify(RateLimitException.builder().headers(headers())
                .body(body("rate_limit_error", "see billing for your tier")).build()));
        assertEquals(NONE, classify(InternalServerException.builder().statusCode(529).headers(headers())
                .body(body("overloaded_error", "authentication backend overloaded")).build()));
    }

    @Test
    void aQuotaCodeOnATransientStatusStillClearsTheGoal() {
        // OpenAI sends an exhausted quota as a 429, which the provider marks transient.
        assertEquals(of(UnrecoverableError.BILLING), classify(new TransientProviderException(
                "OpenAI-compatible server HTTP 429: {\"error\":{\"code\":\"credit_balance_exhausted\"}}")));
        assertEquals(of(UnrecoverableError.BILLING), classify(new TransientProviderException(
                "OpenAI-compatible server HTTP 429: {\"error\":{\"code\":\"insufficient_quota\"}}")));
        assertEquals(NONE, classify(new TransientProviderException("OpenAI-compatible server HTTP 429: slow down")),
                "a plain rate limit does not");
    }
}
