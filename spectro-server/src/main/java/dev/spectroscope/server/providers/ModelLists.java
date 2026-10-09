package dev.spectroscope.server.providers;

import com.fasterxml.jackson.databind.JsonNode;
import dev.spectroscope.core.provider.OpenAiCompatProvider;
import org.springframework.http.client.SimpleClientHttpRequestFactory;
import org.springframework.web.client.HttpClientErrorException;
import org.springframework.web.client.HttpServerErrorException;
import org.springframework.web.client.ResourceAccessException;
import org.springframework.web.client.RestClient;

import java.net.ConnectException;
import java.net.SocketTimeoutException;
import java.net.http.HttpTimeoutException;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.List;

/**
 * The three model list wires (anthropic, ollama, OpenAI compatible), each
 * answering a {@link ListResult} that keeps the reason for a failure. The
 * curated fallbacks are not here: they are the model route's business
 * ({@code SessionsController.models}), because a registry row must never
 * carry a list that looks live and is not.
 */
public final class ModelLists {

    private ModelLists() {
    }

    /** The Anthropic Models API, fixed endpoint, versioned like the SDK does it. */
    static final String ANTHROPIC_MODELS_URL = "https://api.anthropic.com/v1/models?limit=50";
    static final String ANTHROPIC_VERSION = "2023-06-01";

    /** Model families the chat picker must not offer; the /v1/models list carries everything. */
    static final List<String> NON_CHAT_MODEL_MARKERS = List.of(
            "embedding", "tts", "whisper", "dall-e", "audio", "realtime",
            "moderation", "transcribe", "davinci", "babbage", "image", "sora");

    /**
     * A client with finite connect and read timeouts. RestClient.create() would
     * inherit the classpath's default factory, whose read timeout is unbounded:
     * a backend that accepts the connection and never answers would pin the
     * Tomcat worker forever.
     */
    static final RestClient PROBE = RestClient.builder().requestFactory(probeFactory()).build();

    private static SimpleClientHttpRequestFactory probeFactory() {
        SimpleClientHttpRequestFactory f = new SimpleClientHttpRequestFactory();
        f.setConnectTimeout(1500);
        f.setReadTimeout(2500);
        return f;
    }

    static boolean isChatModel(String id) {
        String lower = id.toLowerCase();
        return NON_CHAT_MODEL_MARKERS.stream().noneMatch(lower::contains);
    }

    /**
     * Reads the Anthropic Models API with this key. No key means no request.
     *
     * @param key the API key, or null
     * @return the model ids, or the reason they did not arrive
     */
    public static ListResult anthropic(String key) {
        if (key == null || key.isBlank()) {
            return ListResult.failed("no-key", ANTHROPIC_MODELS_URL);
        }
        try {
            JsonNode page = PROBE.get()
                    .uri(ANTHROPIC_MODELS_URL)
                    .header("x-api-key", key)
                    .header("anthropic-version", ANTHROPIC_VERSION)
                    .retrieve().body(JsonNode.class);
            if (page == null || !page.has("data")) {
                return ListResult.failed("bad-answer", ANTHROPIC_MODELS_URL);
            }
            List<String> ids = new ArrayList<>();
            for (JsonNode entry : page.get("data")) {
                String id = entry.path("id").asText("");
                if (!id.isBlank()) {
                    ids.add(id);
                }
            }
            return ListResult.ok(ids, ANTHROPIC_MODELS_URL);
        } catch (Exception failure) {
            return ListResult.failed(reasonOf(failure), ANTHROPIC_MODELS_URL);
        }
    }

    /**
     * Reads the installed models from an ollama's {@code /api/tags}.
     *
     * @param base the ollama address
     * @return the tag names, possibly none, or the reason they did not arrive
     */
    public static ListResult ollama(String base) {
        String url = base + "/api/tags";
        try {
            JsonNode tags = PROBE.get().uri(url).retrieve().body(JsonNode.class);
            if (tags == null || !tags.has("models")) {
                return ListResult.failed("bad-answer", base);
            }
            List<String> names = new ArrayList<>();
            for (JsonNode entry : tags.get("models")) {
                String name = entry.path("name").asText("");
                if (!name.isBlank()) {
                    names.add(name);
                }
            }
            return ListResult.ok(names, base);
        } catch (Exception failure) {
            return ListResult.failed(reasonOf(failure), base);
        }
    }

    /**
     * Reads {@code /v1/models} from an OpenAI compatible server, chat models
     * only, newest first, at most 60. A key rides as a Bearer when present.
     *
     * @param provider the provider name
     * @param base     the provider's effective address
     * @param key      the API key, or null for a keyless local server
     * @return the model ids, or the reason they did not arrive
     */
    public static ListResult openAiCompat(String provider, String base, String key) {
        boolean hasKey = key != null && !key.isBlank();
        try {
            RestClient.RequestHeadersSpec<?> request = PROBE.get()
                    .uri(base + OpenAiCompatProvider.compatPath(base, "/models"));
            if (hasKey) {
                request = request.header("Authorization", "Bearer " + key);
            }
            JsonNode page = request.retrieve().body(JsonNode.class);
            if (page == null || !page.has("data")) {
                return ListResult.failed("bad-answer", base);
            }
            record ModelRow(String id, long created) {}
            List<ModelRow> rows = new ArrayList<>();
            for (JsonNode entry : page.get("data")) {
                String id = entry.path("id").asText("");
                if (!id.isBlank() && isChatModel(id)) {
                    rows.add(new ModelRow(id, entry.path("created").asLong(0)));
                }
            }
            List<String> ids = rows.stream()
                    .sorted(Comparator.comparingLong(ModelRow::created).reversed())
                    .map(ModelRow::id)
                    .limit(60)
                    .toList();
            return ListResult.ok(ids, base);
        } catch (Exception failure) {
            return ListResult.failed(reasonOf(failure), base);
        }
    }

    /** One reason code per failure class. Everything unknown is a bad answer. */
    static String reasonOf(Exception failure) {
        if (failure instanceof HttpClientErrorException http) {
            int status = http.getStatusCode().value();
            return status == 401 || status == 403 ? "rejected-key" : "http-" + status;
        }
        if (failure instanceof HttpServerErrorException http) {
            return "http-" + http.getStatusCode().value();
        }
        if (failure instanceof ResourceAccessException io) {
            Throwable cause = io.getCause();
            if (cause instanceof SocketTimeoutException || cause instanceof HttpTimeoutException) {
                return "timeout";
            }
            if (cause instanceof ConnectException) {
                return "refused";
            }
            return "refused";
        }
        return "bad-answer";
    }
}
