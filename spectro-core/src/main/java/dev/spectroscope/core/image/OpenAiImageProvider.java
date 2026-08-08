package dev.spectroscope.core.image;

import com.fasterxml.jackson.annotation.JsonIgnoreProperties;
import com.fasterxml.jackson.annotation.JsonProperty;
import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.ObjectMapper;
import dev.spectroscope.core.wire.LlmWireTap;
import org.springframework.http.MediaType;
import org.springframework.web.client.RestClient;
import org.springframework.web.client.RestClientException;

import java.nio.charset.StandardCharsets;
import java.util.Base64;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.Optional;

/**
 * Image generation via OpenAI's {@code /v1/images/generations} endpoint. Same
 * construction as {@link GeminiImageProvider}: Spring {@link RestClient}, typed
 * wire records, readable errors.
 *
 * <p>The response carries the image base64-encoded in {@code data[0].b64_json};
 * {@code gpt-image-1} returns PNG by default, so the media type is fixed.</p>
 */
public final class OpenAiImageProvider implements ImageProvider {

    /** Serializes the request the provider POSTS — the same string goes to the
     *  socket AND the wire record, which is what fidelity "bytes" promises. */
    private static final ObjectMapper JSON = new ObjectMapper();

    private final RestClient http;
    private final String baseUrl;
    private final String apiKey;
    private final String model;

    /**
     * Builds the HTTP client against the configured origin — a trailing slash is
     * trimmed so the URI concatenates cleanly.
     *
     * @param options endpoint, API key, and model used for every request
     */
    /** Image renders are SLOW (30–90 s is normal for gpt-image) — the read
     *  timeout must outlast them; the auto-detected client cut at ~60 s and
     *  failed real generations (found live 2026-07-17). */
    private static final java.time.Duration CONNECT_TIMEOUT = java.time.Duration.ofSeconds(10);
    private static final java.time.Duration READ_TIMEOUT = java.time.Duration.ofSeconds(120);

    public OpenAiImageProvider(OpenAiImageOptions options) {
        var factory = new org.springframework.http.client.SimpleClientHttpRequestFactory();
        factory.setConnectTimeout((int) CONNECT_TIMEOUT.toMillis());
        factory.setReadTimeout((int) READ_TIMEOUT.toMillis());
        this.baseUrl = options.baseUrl().replaceAll("/$", "");
        this.http = RestClient.builder()
                .requestFactory(factory)
                .baseUrl(baseUrl)
                .build();
        this.apiKey = options.apiKey();
        this.model = options.model();
    }

    /**
     * One blocking {@code /v1/images/generations} round-trip: posts the prompt at a
     * fixed 1024x1024 and decodes the first {@code b64_json} entry of the answer.
     *
     * @param prompt textual description of the desired image, sent verbatim
     * @return the decoded image bytes with the fixed {@code image/png} media type
     */
    @Override
    public Generated generate(String prompt) {
        return generate(prompt, null);
    }

    /**
     * The tap-aware round-trip (card 184): the posted body is the exact string
     * recorded (fidelity "bytes"), the response JSON rides the record verbatim,
     * {@code b64_json} included. Header values go to the tap REAL; the recorder
     * redacts credentials itself. A null tap records nothing.
     *
     * @param prompt textual description of the desired image, sent verbatim
     * @param tap    where the exchange is recorded; null records nothing
     * @return the decoded image bytes with the fixed {@code image/png} media type
     */
    @Override
    public Generated generate(String prompt, LlmWireTap tap) {
        String requestJson = toJson(new ImagesRequest(model, prompt, 1, "1024x1024"));
        // Announced BEFORE the call: a crash mid-request still leaves it on record.
        LlmWireTap.Exchange exchange = tap == null ? null : tap.begin(new LlmWireTap.WireRequest(
                "openai", model, "http", "POST", baseUrl + "/v1/images/generations",
                Map.of("Authorization", "Bearer " + apiKey, "Content-Type", "application/json"),
                "bytes", requestJson, System.currentTimeMillis()));

        RawResponse raw;
        try {
            raw = http.post()
                    .uri("/v1/images/generations")
                    .header("Authorization", "Bearer " + apiKey)
                    .contentType(MediaType.APPLICATION_JSON)
                    .body(requestJson)
                    .exchange((request, response) -> new RawResponse(
                            response.getStatusCode().value(),
                            new String(response.getBody().readAllBytes(), StandardCharsets.UTF_8)));
        } catch (RuntimeException transportFailure) {
            RuntimeException surfaced = transportFailure instanceof RestClientException
                    ? new RuntimeException(
                            "OpenAI request failed: " + transportFailure.getMessage(), transportFailure)
                    : transportFailure;
            end(exchange, null, null, surfaced.getMessage());
            throw surfaced;
        }

        if (raw.status() >= 400) {
            RuntimeException failure = new RuntimeException("OpenAI HTTP " + raw.status());
            end(exchange, raw.status(), raw.body(), failure.getMessage());
            throw failure;
        }
        end(exchange, raw.status(), raw.body(), null);

        String base64 = Optional.ofNullable(fromJson(raw.body()))
                .map(ImagesResponse::data).orElse(List.of()).stream()
                .map(Datum::b64Json)
                .filter(Objects::nonNull)
                .findFirst()
                .orElseThrow(() -> new RuntimeException(
                        "OpenAI: the response contained no image."));
        return new Generated(Base64.getDecoder().decode(base64), "image/png");
    }

    /** Closes the exchange when there is one; the outcome carries the verbatim body. */
    private static void end(LlmWireTap.Exchange exchange, Integer status, String body, String error) {
        if (exchange != null) {
            exchange.end(new LlmWireTap.WireOutcome(status, "bytes", body, false, error,
                    System.currentTimeMillis()));
        }
    }

    /** Serializes the request record — the exact string that goes over the socket. */
    private static String toJson(ImagesRequest request) {
        try {
            return JSON.writeValueAsString(request);
        } catch (JsonProcessingException impossible) {
            throw new RuntimeException(
                    "OpenAI request failed: " + impossible.getMessage(), impossible);
        }
    }

    /** Parses the verbatim response body into the typed wire records. */
    private static ImagesResponse fromJson(String body) {
        try {
            return JSON.readValue(body, ImagesResponse.class);
        } catch (JsonProcessingException malformed) {
            throw new RuntimeException(
                    "OpenAI request failed: " + malformed.getMessage(), malformed);
        }
    }

    /**
     * The raw answer before any parsing — what the wire record needs.
     *
     * @param status the HTTP status as answered
     * @param body   the response body verbatim
     */
    private record RawResponse(int status, String body) {}

    /** Always {@code "openai"} — the name events and the UI show for this backend. */
    @Override
    public String providerName() {
        return "openai";
    }

    /** The model id this instance was constructed with. */
    @Override
    public String model() {
        return model;
    }

    // ---- wire records (OpenAI images API) -----------------------------------

    /**
     * Request body for {@code /v1/images/generations}.
     *
     * @param model  image model id to generate with
     * @param prompt textual description of the desired image
     * @param n      number of images — always 1 here
     * @param size   output resolution, e.g. {@code 1024x1024}
     */
    record ImagesRequest(String model, String prompt, int n, String size) {}

    /**
     * Response envelope — only the data list is read.
     *
     * @param data generated images; the first base64 entry is used
     */
    @JsonIgnoreProperties(ignoreUnknown = true)
    record ImagesResponse(List<Datum> data) {}

    /**
     * One generated image.
     *
     * @param b64Json base64-encoded image bytes, mapped from the wire's {@code b64_json}
     */
    @JsonIgnoreProperties(ignoreUnknown = true)
    record Datum(@JsonProperty("b64_json") String b64Json) {}
}
