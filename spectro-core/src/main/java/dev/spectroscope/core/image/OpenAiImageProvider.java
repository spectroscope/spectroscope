package dev.spectroscope.core.image;

import com.fasterxml.jackson.annotation.JsonIgnoreProperties;
import com.fasterxml.jackson.annotation.JsonProperty;
import org.springframework.http.HttpStatusCode;
import org.springframework.http.MediaType;
import org.springframework.web.client.RestClient;
import org.springframework.web.client.RestClientException;

import java.util.Base64;
import java.util.List;
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

    private final RestClient http;
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
        this.http = RestClient.builder()
                .requestFactory(factory)
                .baseUrl(options.baseUrl().replaceAll("/$", ""))
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
        ImagesResponse response;
        try {
            response = http.post()
                    .uri("/v1/images/generations")
                    .header("Authorization", "Bearer " + apiKey)
                    .contentType(MediaType.APPLICATION_JSON)
                    .body(new ImagesRequest(model, prompt, 1, "1024x1024"))
                    .retrieve()
                    .onStatus(HttpStatusCode::isError, (request, errorResponse) -> {
                        throw new RuntimeException(
                                "OpenAI HTTP " + errorResponse.getStatusCode().value());
                    })
                    .body(ImagesResponse.class);
        } catch (RestClientException transportFailure) {
            throw new RuntimeException(
                    "OpenAI request failed: " + transportFailure.getMessage(), transportFailure);
        }

        String base64 = Optional.ofNullable(response)
                .map(ImagesResponse::data).orElse(List.of()).stream()
                .map(Datum::b64Json)
                .filter(Objects::nonNull)
                .findFirst()
                .orElseThrow(() -> new RuntimeException(
                        "OpenAI: the response contained no image."));
        return new Generated(Base64.getDecoder().decode(base64), "image/png");
    }

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
