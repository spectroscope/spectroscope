package dev.spectroscope.server;

import com.fasterxml.jackson.databind.JsonNode;
import dev.spectroscope.core.config.SpectroConfig;
import dev.spectroscope.core.provider.ReasoningCapabilities;
import dev.spectroscope.core.provider.ReasoningCapability;
import org.springframework.http.client.SimpleClientHttpRequestFactory;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.client.RestClient;

import java.util.ArrayList;
import java.util.List;
import java.util.Map;

/**
 * The capability sibling of {@code /api/models} (card 88): what one
 * (provider, model) pair honestly supports for reasoning control, as the
 * {@link ReasoningCapability} record — the same record the providers gate
 * their wire fields on, so the picker and the request path share ONE truth.
 *
 * <p>Static dialects (openai, gemini, lmstudio, spectro-local, custom bases)
 * answer straight from the bundled table. Three providers have real API
 * discovery and get a live overlay: anthropic's Models API (thinking/effort
 * flags per model — the cross-field rules the API does not encode stay from
 * the table), ollama's {@code /api/show} (a binary "thinking" capability; the
 * bool-vs-levels shape still comes from the family table) and openrouter's
 * public model list ({@code reasoning} object + {@code supported_parameters}).
 * Any dark API falls back to the static row — the picker keeps rendering.</p>
 *
 * <p>No {@code @CrossOrigin}, same as the sibling endpoints: served same-origin
 * from this jar, proxied by the dev vite server.</p>
 */
@RestController
public class ModelCapabilityController {

    private static final String ANTHROPIC_VERSION = "2023-06-01";

    private final String anthropicBase;
    private final String openrouterBase;
    private final String ollamaBaseOverride;
    private final String anthropicKeyOverride;

    /** The probe client — finite timeouts like the model-list probes: a
     *  black-holed backend must never pin a Tomcat worker. The read timeout is
     *  wider than the model-list probe's because openrouter's full list is the
     *  one big answer on this path. */
    private final RestClient probe = RestClient.builder()
            .requestFactory(probeFactory())
            .build();

    /** Production wiring: the real endpoints, key and base from the config. */
    public ModelCapabilityController() {
        this("https://api.anthropic.com", "https://openrouter.ai", null, null);
    }

    /**
     * Visible for tests: scripted endpoints instead of the real APIs.
     *
     * @param anthropicBase        the Anthropic API root
     * @param openrouterBase       the OpenRouter root
     * @param ollamaBaseOverride   the Ollama root, or null to read the config
     * @param anthropicKeyOverride the key, or null to resolve ANTHROPIC_API_KEY
     */
    ModelCapabilityController(String anthropicBase, String openrouterBase,
                              String ollamaBaseOverride, String anthropicKeyOverride) {
        this.anthropicBase = anthropicBase;
        this.openrouterBase = openrouterBase;
        this.ollamaBaseOverride = ollamaBaseOverride;
        this.anthropicKeyOverride = anthropicKeyOverride;
    }

    private static SimpleClientHttpRequestFactory probeFactory() {
        SimpleClientHttpRequestFactory factory = new SimpleClientHttpRequestFactory();
        factory.setConnectTimeout(1500);
        factory.setReadTimeout(4000);
        return factory;
    }

    /**
     * The reasoning capability for one (provider, model) pair.
     *
     * @param provider the provider label the picker holds
     * @param model    the model id the picker holds
     * @return the record; unknown providers answer control="none", never an error
     */
    @GetMapping("/api/models/capabilities")
    public ReasoningCapability capabilities(@RequestParam(name = "provider") String provider,
                                            @RequestParam(name = "model") String model) {
        return switch (provider) {
            case "anthropic" -> anthropicCapability(model);
            case "ollama" -> ollamaCapability(model);
            case "openrouter" -> openrouterCapability(model);
            default -> ReasoningCapabilities.resolve(provider, model);
        };
    }

    /**
     * Anthropic: {@code GET /v1/models/{id}} carries per-model thinking and
     * effort flags. The overlay narrows the static effort list to the levels
     * the API confirms and turns non-thinkers to "none"; offSwitch,
     * offMaxEffort and defaultOn stay from the table — the three cross-field
     * rules (fable/mythos reject disabled, opus-5's disabled×xhigh 400, the
     * 4.6 budget deprecation) are NOT encoded in the Models API.
     */
    private ReasoningCapability anthropicCapability(String model) {
        ReasoningCapability fallback = ReasoningCapabilities.resolve("anthropic", model);
        String key = anthropicKeyOverride != null
                ? anthropicKeyOverride : SpectroConfig.resolveApiKey("ANTHROPIC_API_KEY");
        if (key == null || key.isBlank() || model == null || model.isBlank()) {
            return fallback;
        }
        try {
            JsonNode answer = probe.get()
                    .uri(anthropicBase + "/v1/models/" + model)
                    .header("x-api-key", key)
                    .header("anthropic-version", ANTHROPIC_VERSION)
                    .retrieve().body(JsonNode.class);
            JsonNode caps = answer == null ? null : answer.get("capabilities");
            if (caps == null) {
                return fallback;
            }
            if (!caps.path("thinking").path("supported").asBoolean(false)) {
                return ReasoningCapability.none("api");
            }
            List<String> efforts = fallback.efforts();
            if (caps.path("effort").path("supported").asBoolean(false)) {
                List<String> confirmed = new ArrayList<>();
                for (String level : List.of("low", "medium", "high", "xhigh", "max")) {
                    if (caps.path("effort").path(level).path("supported").asBoolean(false)) {
                        confirmed.add(level);
                    }
                }
                if (!confirmed.isEmpty()) {
                    efforts = confirmed;
                }
            }
            String control = efforts.isEmpty() ? "toggle" : "effort";
            return new ReasoningCapability(control, fallback.defaultOn(), fallback.offSwitch(),
                    efforts, fallback.defaultEffort(), fallback.offMaxEffort(),
                    fallback.wire(), "api");
        } catch (Exception apiDark) {
            return fallback;
        }
    }

    /**
     * Ollama: {@code POST /api/show} answers a binary {@code capabilities[]}.
     * "thinking" absent outranks the family table (the model simply cannot);
     * present confirms the table row, whose shape (bool vs levels) the API
     * cannot express.
     */
    private ReasoningCapability ollamaCapability(String model) {
        ReasoningCapability fallback = ReasoningCapabilities.resolve("ollama", model);
        try {
            String base = ollamaBaseOverride != null ? ollamaBaseOverride : configuredOllamaBase();
            JsonNode answer = probe.post()
                    .uri(base + "/api/show")
                    .body(Map.of("model", model == null ? "" : model))
                    .retrieve().body(JsonNode.class);
            if (answer == null || !answer.has("capabilities")) {
                return fallback;
            }
            for (JsonNode capability : answer.get("capabilities")) {
                if ("thinking".equals(capability.asText())) {
                    return fallback.withSource("api");
                }
            }
            return ReasoningCapability.none("api");
        } catch (Exception apiDark) {
            return fallback;
        }
    }

    /**
     * OpenRouter: the public model list carries a per-model {@code reasoning}
     * object and a {@code supported_parameters} array. The two signals are
     * OR-ed (the list is known to be inconsistent); neither present means no
     * control. Efforts ride verbatim in the gateway's order.
     */
    private ReasoningCapability openrouterCapability(String model) {
        ReasoningCapability fallback = ReasoningCapabilities.resolve("openrouter", model);
        try {
            JsonNode page = probe.get()
                    .uri(openrouterBase + "/api/v1/models")
                    .retrieve().body(JsonNode.class);
            if (page == null || !page.has("data")) {
                return fallback;
            }
            for (JsonNode entry : page.get("data")) {
                if (!entry.path("id").asText().equals(model)) {
                    continue;
                }
                JsonNode reasoning = entry.get("reasoning");
                boolean listed = false;
                for (JsonNode parameter : entry.path("supported_parameters")) {
                    listed |= "reasoning".equals(parameter.asText());
                }
                if (reasoning == null && !listed) {
                    return ReasoningCapability.none("api");
                }
                List<String> efforts = new ArrayList<>();
                if (reasoning != null) {
                    reasoning.path("supported_efforts").forEach(e -> efforts.add(e.asText()));
                }
                boolean mandatory = reasoning != null && reasoning.path("mandatory").asBoolean(false);
                String defaultEffort = reasoning != null && reasoning.hasNonNull("default_effort")
                        ? reasoning.get("default_effort").asText() : null;
                boolean defaultOn = reasoning != null
                        ? reasoning.path("default_enabled").asBoolean(mandatory) : false;
                return new ReasoningCapability(
                        efforts.isEmpty() ? "toggle" : "effort",
                        defaultOn, !mandatory, efforts, defaultEffort, null, "reasoning", "api");
            }
            // Model not in the list at all — no reasoning claim can be made.
            return ReasoningCapability.none("api");
        } catch (Exception apiDark) {
            return fallback;
        }
    }

    /** The configured Ollama root — the same rule the model list uses. */
    private static String configuredOllamaBase() {
        SpectroConfig config = SpectroConfig.load(SpectroConfig.Overrides.none());
        return config.baseUrl() == null || config.baseUrl().isBlank()
                ? "http://localhost:11434" : config.baseUrl();
    }
}
