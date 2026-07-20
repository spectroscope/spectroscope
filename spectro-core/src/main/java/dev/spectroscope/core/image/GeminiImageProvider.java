package dev.spectroscope.core.image;

import com.fasterxml.jackson.annotation.JsonIgnoreProperties;
import com.fasterxml.jackson.annotation.JsonInclude;
import org.springframework.http.HttpStatusCode;
import org.springframework.http.MediaType;
import org.springframework.web.client.RestClient;
import org.springframework.web.client.RestClientException;

import java.util.Base64;
import java.util.List;
import java.util.Objects;
import java.util.Optional;

/**
 * Image generation via Google's Gemini {@code generateContent} endpoint. Built in
 * the house style of the chat providers: Spring {@link RestClient} plus typed wire
 * records instead of hand-rolled JSON trees.
 *
 * <p>Gemini answers with a parts list that may mix text and inline image data —
 * the first part carrying {@code inlineData} is the image. A response without one
 * is an error the model can read.</p>
 */
public final class GeminiImageProvider implements ImageProvider {

    private final RestClient http;
    private final String apiKey;
    private final String model;

    /**
     * Builds the HTTP client against the configured origin — a trailing slash is
     * trimmed so the URI template concatenates cleanly.
     *
     * @param options endpoint, API key, and model used for every request
     */
    public GeminiImageProvider(GeminiImageOptions options) {
        // Image renders are SLOW — same generous timeouts as the OpenAI twin
        // (the auto-detected client cut at ~60 s and failed real generations).
        var factory = new org.springframework.http.client.SimpleClientHttpRequestFactory();
        factory.setConnectTimeout(10_000);
        factory.setReadTimeout(120_000);
        this.http = RestClient.builder()
                .requestFactory(factory)
                .baseUrl(options.baseUrl().replaceAll("/$", ""))
                .build();
        this.apiKey = options.apiKey();
        this.model = options.model();
    }

    /**
     * One blocking {@code generateContent} round-trip: the prompt goes out as a single
     * text part, the first {@code inlineData} part of the answer comes back decoded.
     * A missing {@code mimeType} defaults to {@code image/png}.
     *
     * @param prompt textual description of the desired image, sent verbatim
     * @return the decoded image bytes plus their media type
     */
    @Override
    public Generated generate(String prompt) {
        GenerateContentResponse response;
        try {
            response = http.post()
                    .uri("/v1beta/models/{model}:generateContent", model)
                    .header("x-goog-api-key", apiKey)
                    .contentType(MediaType.APPLICATION_JSON)
                    .body(new GenerateContentRequest(
                            List.of(new Content(List.of(Part.text(prompt))))))
                    .retrieve()
                    .onStatus(HttpStatusCode::isError, (request, errorResponse) -> {
                        throw new RuntimeException(
                                "Gemini HTTP " + errorResponse.getStatusCode().value());
                    })
                    .body(GenerateContentResponse.class);
        } catch (RestClientException transportFailure) {
            throw new RuntimeException(
                    "Gemini request failed: " + transportFailure.getMessage(), transportFailure);
        }

        InlineData image = Optional.ofNullable(response)
                .map(GenerateContentResponse::candidates).orElse(List.of()).stream()
                .map(Candidate::content).filter(Objects::nonNull)
                .map(Content::parts).filter(Objects::nonNull)
                .flatMap(List::stream)
                .map(Part::inlineData)
                .filter(Objects::nonNull)
                .findFirst()
                .orElseThrow(() -> new RuntimeException(
                        "Gemini: the response contained no image."));

        return new Generated(
                Base64.getDecoder().decode(image.data()),
                Optional.ofNullable(image.mimeType()).orElse("image/png"));
    }

    /** Always {@code "gemini"} — the name events and the UI show for this backend. */
    @Override
    public String providerName() {
        return "gemini";
    }

    /** The model id this instance was constructed with. */
    @Override
    public String model() {
        return model;
    }

    // ---- wire records (Gemini generateContent) ------------------------------
    // Shared between request and response: the request only ever fills text,
    // the response mixes text and inlineData parts.

    /**
     * Request envelope: the {@code contents} list Gemini expects.
     *
     * @param contents conversation turns — here always one user content with a single text part
     */
    record GenerateContentRequest(List<Content> contents) {}

    /**
     * A content block, shared by request and response.
     *
     * @param parts the block's parts — text only in requests, text and/or image data in responses
     */
    @JsonIgnoreProperties(ignoreUnknown = true)
    record Content(List<Part> parts) {}

    /**
     * One content part. Requests only ever fill {@code text}; responses may carry
     * either member, and {@code null}s are dropped from the wire.
     *
     * @param text       textual payload, or {@code null} for an image part
     * @param inlineData embedded image payload, or {@code null} for a text part
     */
    @JsonInclude(JsonInclude.Include.NON_NULL)
    @JsonIgnoreProperties(ignoreUnknown = true)
    record Part(String text, InlineData inlineData) {
        /**
         * Request-side factory: a pure text part, the only kind a request ever sends.
         *
         * @param text the prompt text to wrap
         * @return a part carrying only {@code text}
         */
        static Part text(String text) {
            return new Part(text, null);
        }
    }

    /**
     * The image payload as Gemini inlines it.
     *
     * @param mimeType media type of the encoded bytes, e.g. {@code image/png}
     * @param data     base64-encoded image bytes
     */
    @JsonIgnoreProperties(ignoreUnknown = true)
    record InlineData(String mimeType, String data) {}

    /**
     * Response envelope — only the candidates are read.
     *
     * @param candidates generated answers, scanned for the first inline image
     */
    @JsonIgnoreProperties(ignoreUnknown = true)
    record GenerateContentResponse(List<Candidate> candidates) {}

    /**
     * One generated candidate.
     *
     * @param content the candidate's content block, possibly {@code null}
     */
    @JsonIgnoreProperties(ignoreUnknown = true)
    record Candidate(Content content) {}
}
