package dev.spectroscope.core.provider;

import com.fasterxml.jackson.annotation.JsonIgnoreProperties;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.client.RestClient;
import org.springframework.web.client.support.RestClientAdapter;
import org.springframework.web.service.annotation.GetExchange;
import org.springframework.web.service.annotation.PostExchange;
import org.springframework.web.service.invoker.HttpServiceProxyFactory;

import java.util.List;

/**
 * Declarative HTTP interface for Ollama's non-streaming endpoints — Spring
 * generates the implementation at runtime ({@link HttpServiceProxyFactory}),
 * the same programming model as a Feign client. The streaming chat endpoint
 * stays in {@link OllamaProvider} on the raw {@link RestClient}: NDJSON must
 * be read line by line while the response is still open, which a declarative
 * return type cannot express.
 */
public interface OllamaApi {

    /**
     * GET /api/version — the cheapest "is Ollama reachable?" probe.
     *
     * @return the server's version record
     */
    @GetExchange("/api/version")
    Version version();

    /**
     * The version endpoint's response body.
     *
     * @param version the Ollama server version string
     */
    record Version(String version) {}

    /**
     * POST /api/show — model metadata; the vision path reads the capabilities list.
     *
     * @param request names the model to describe
     * @return the model's metadata (capabilities may be null on older servers)
     */
    @PostExchange("/api/show")
    Show show(@RequestBody ShowRequest request);

    /**
     * The show endpoint's request body.
     *
     * @param model the model name to look up, e.g. "qwen3"
     */
    record ShowRequest(String model) {}

    /**
     * Older Ollama versions ship no capabilities — the list stays null then.
     *
     * @param capabilities the model's capability tags (e.g. "vision"), or null
     */
    @JsonIgnoreProperties(ignoreUnknown = true)
    record Show(List<String> capabilities) {}

    /**
     * Builds the runtime proxy over an existing RestClient (shared base URL).
     *
     * @param client the configured RestClient the proxy sends through
     * @return a Spring-generated implementation of this interface
     */
    static OllamaApi create(RestClient client) {
        return HttpServiceProxyFactory
                .builderFor(RestClientAdapter.create(client))
                .build()
                .createClient(OllamaApi.class);
    }
}
