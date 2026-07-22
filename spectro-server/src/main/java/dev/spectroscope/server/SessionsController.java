package dev.spectroscope.server;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import dev.spectroscope.core.config.SpectroConfig;
import dev.spectroscope.core.events.RunEvent;
import dev.spectroscope.core.scheduler.JobState;
import dev.spectroscope.core.session.SessionStore;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.CrossOrigin;
import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.http.client.SimpleClientHttpRequestFactory;
import org.springframework.web.client.RestClient;

import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.regex.Pattern;

/**
 * The REST endpoints alongside the socket. Read-only except ONE deliberate
 * mutation: deleting a stored session (the socket carries every run-time
 * mutation). The endpoints read the SAME JSONL store the CLI writes, so
 * file, socket and REST all speak the one RunEvent format.
 */
@RestController
@CrossOrigin(origins = "*")   // for the Vite dev server on :5173; one JAR needs no CORS
public class SessionsController {

    /**
     * The sidebar list.
     *
     * @return every stored session's metadata, straight from the JSONL store
     */
    @GetMapping("/api/sessions")
    public List<SessionStore.SessionInfo> sessions() {
        return SessionStore.listSessions();
    }

    /**
     * The events of one session as JSON — the graph tab replays exactly this.
     *
     * @param id the session id whose JSONL file is read
     * @return 200 with every parsed RunEvent; 404 when the session cannot be read
     */
    @GetMapping("/api/sessions/{id}/events")
    public ResponseEntity<List<RunEvent>> events(@PathVariable String id) {
        try {
            return ResponseEntity.ok(SessionStore.readSessionEvents(id));
        } catch (Exception missing) {
            return ResponseEntity.notFound().build();
        }
    }

    /** Session ids as the store mints them (yyyyMMdd-HHmmss-uuid8) plus the
     *  test/CLI-friendly general shape — never a path, never a dot. */
    private static final Pattern SESSION_ID = Pattern.compile("[A-Za-z0-9][A-Za-z0-9-]*");

    /**
     * Deletes one stored session (its JSONL file and its blob folder) — the
     * one deliberately destructive endpoint. Defense in depth: the id shape
     * is checked here AND the store only deletes direct children of the
     * sessions directory. 204 on success, 404 for an unknown id, 400 for
     * anything that is not a session id.
     *
     * @param id the session id from the URL — untrusted, shape-checked before
     *           any file system contact
     */
    @DeleteMapping("/api/sessions/{id}")
    public ResponseEntity<Void> deleteSession(@PathVariable String id) {
        if (!SESSION_ID.matcher(id).matches()) {
            return ResponseEntity.badRequest().build();
        }
        try {
            return SessionStore.deleteSession(id)
                    ? ResponseEntity.noContent().build()
                    : ResponseEntity.notFound().build();
        } catch (Exception failure) {
            return ResponseEntity.internalServerError().build();
        }
    }

    /**
     * The health probe the desktop shell polls before loading the UI.
     *
     * @return always {@code {"status": "ok"}} — being reachable IS the signal
     */
    @GetMapping("/api/health")
    public Map<String, String> health() {
        return Map.of("status", "ok");
    }

    /**
     * The active LLM backend for the header + the Lab map: the boot config's
     * provider and model (the same layers the socket builds its agent from). A
     * mid-session switch is reflected client-side by the set_provider round-trip;
     * this is the initial truth so the UI never has to guess the model.
     *
     * @return provider and model as strings — empty (never null) when unset
     */
    @GetMapping("/api/config")
    public Map<String, String> config() {
        SpectroConfig c = SpectroConfig.load(SpectroConfig.Overrides.none());
        Map<String, String> out = new LinkedHashMap<>();
        out.put("provider", c.provider() == null ? "" : c.provider());
        out.put("model", c.model() == null ? "" : c.model());
        // Settings page (additive): the boot log level, read-only in the UI —
        // changing it stays a config/env decision .
        out.put("logLevel", c.logLevel() == null ? "" : c.logLevel());
        // Image-backend key PRESENCE (never values): the gallery picker uses
        // this to pre-select a backend that can actually generate and to mark
        // the keyless ones in the dropdown.
        out.put("geminiKey", String.valueOf(envKeySet("GEMINI_API_KEY")));
        out.put("openaiKey", String.valueOf(envKeySet("OPENAI_API_KEY")));
        return out;
    }

    /** Whether an env-provided key is present and non-blank — presence only,
     *  the value never leaves the process.
     *  @param name the environment variable to probe
     *  @return true when set and non-blank */
    private static boolean envKeySet(String name) {
        String v = System.getenv(name);
        return v != null && !v.isBlank();
    }

    /**
     * What goes to the LLM BEFORE any user message — the main agent's assembled
     * system prompt, tools, skills, MCP servers and the subagent role profiles.
     * The "System-Kontext" tab renders this; it is stateless (no Agent built, MCP
     * not connected), so the client overlays any live provider/model/thinking switch.
     *
     * @return the context assembled fresh for the server process's working directory
     */
    @GetMapping("/api/context")
    public ContextInfo context() {
        SpectroConfig c = SpectroConfig.load(SpectroConfig.Overrides.none());
        return ContextDescriber.describe(c, Path.of(System.getProperty("user.dir")));
    }

    /** Curated fallbacks — used when the live model APIs are unreachable. */
    private static final List<String> ANTHROPIC_MODELS =
            List.of("claude-opus-4-8", "claude-sonnet-5", "claude-haiku-4-5", "claude-opus-4-7");
    private static final List<String> OPENAI_MODELS =
            List.of("gpt-4o", "gpt-4o-mini", "gpt-4.1", "gpt-4.1-mini", "o3-mini");

    /** The Anthropic Models API — fixed endpoint, versioned like the SDK does it. */
    private static final String ANTHROPIC_MODELS_URL = "https://api.anthropic.com/v1/models?limit=50";
    private static final String ANTHROPIC_VERSION = "2023-06-01";

    /**
     * Model names for the header picker's per-provider dropdown — all three
     * backends are LIVE now: Ollama from its /api/tags (the actually-installed
     * models), Anthropic from its Models API (what the key can use), and
     * openai from the EFFECTIVE endpoint's /v1/models — api.openai.com when a
     * key rides the untouched default, the local OpenAI-compatible server
     * (LM Studio answers /v1/models keyless) otherwise. Curated lists remain
     * the fallback; empty only for unknown providers.
     *
     * @param provider "anthropic" | "openai" | "ollama" — anything else answers empty
     */
    @GetMapping("/api/models")
    public List<String> models(@RequestParam(name = "provider", defaultValue = "") String provider) {
        return switch (provider) {
            case "anthropic" -> anthropicModels();
            case "openai", "lmstudio", "openrouter" -> openaiModels(provider);
            case "ollama" -> ollamaModels();
            default -> List.of();
        };
    }

    /**
     * A dedicated client for the model-list probes with FINITE connect + read
     * timeouts. RestClient.create() would inherit the classpath's default
     * factory, whose read timeout is unbounded — a backend that accepts the TCP
     * connection but never answers (a stalled/black-holed Ollama) would then pin
     * the Tomcat worker forever. The JDK factory guarantees the timeouts hold
     * regardless of which HTTP client is on the classpath.
     */
    private static final RestClient MODEL_PROBE = RestClient.builder()
            .requestFactory(modelProbeFactory())
            .build();

    /**
     * The probe's JDK request factory — the one place the finite timeouts live.
     *
     * @return a factory enforcing 1.5 s connect and 2.5 s read timeouts
     */
    private static SimpleClientHttpRequestFactory modelProbeFactory() {
        SimpleClientHttpRequestFactory f = new SimpleClientHttpRequestFactory();
        f.setConnectTimeout(1500);
        f.setReadTimeout(2500);
        return f;
    }

    /** Model families the chat picker must not offer — the /v1/models list carries everything. */
    private static final List<String> NON_CHAT_MODEL_MARKERS = List.of(
            "embedding", "tts", "whisper", "dall-e", "audio", "realtime",
            "moderation", "transcribe", "davinci", "babbage", "image", "sora");

    /** Whether a model id looks like a chat-completions candidate.
     *  @param id the model id from /v1/models
     *  @return false for embedding/speech/image/legacy families */
    private static boolean isChatModel(String id) {
        String lower = id.toLowerCase();
        return NON_CHAT_MODEL_MARKERS.stream().noneMatch(lower::contains);
    }

    /**
     * Asks the EFFECTIVE openai endpoint for its models — live like the other
     * two backends: api.openai.com when a key rides the untouched default
     * (Bearer attached), the configured OpenAI-compatible server otherwise
     * (LM Studio answers /v1/models without a key). Non-chat families are
     * filtered, newest first; any failure falls back to the curated list.
     *
     * @return chat-capable model ids, newest first, or the curated fallback
     */
    private List<String> openaiModels(String provider) {
        try {
            SpectroConfig c = SpectroConfig.load(SpectroConfig.Overrides.none());
            String key = "openrouter".equals(provider)
                    ? System.getenv("OPENROUTER_API_KEY")
                    : System.getenv("OPENAI_API_KEY");
            boolean hasKey = key != null && !key.isBlank();
            String base = SpectroConfig.effectiveOpenAiBaseUrl(provider, c.baseUrl());

            RestClient.RequestHeadersSpec<?> request = MODEL_PROBE.get().uri(base + "/v1/models");
            if (hasKey) {
                request = request.header("Authorization", "Bearer " + key);
            }
            JsonNode page = request.retrieve().body(JsonNode.class);

            record ModelRow(String id, long created) {}
            List<ModelRow> rows = new ArrayList<>();
            if (page != null && page.has("data")) {
                for (JsonNode entry : page.get("data")) {
                    String id = entry.path("id").asText("");
                    if (!id.isBlank() && isChatModel(id)) {
                        rows.add(new ModelRow(id, entry.path("created").asLong(0)));
                    }
                }
            }
            List<String> ids = rows.stream()
                    .sorted(java.util.Comparator.comparingLong(ModelRow::created).reversed())
                    .map(ModelRow::id)
                    .limit(60)
                    .toList();
            return ids.isEmpty() ? OPENAI_MODELS : ids;
        } catch (Exception apiUnreachable) {
            return OPENAI_MODELS;
        }
    }

    /**
     * Asks the Anthropic Models API which models this key can use — live like
     * the Ollama tags, so the picker names what actually exists instead of a
     * hardcoded guess. No key, an unreachable API or an empty answer fall back
     * to the curated list (still better than an empty picker).
     *
     * @return the model ids the API reports, newest first, or the curated list
     */
    private List<String> anthropicModels() {
        String key = System.getenv("ANTHROPIC_API_KEY");
        if (key == null || key.isBlank()) {
            return ANTHROPIC_MODELS;
        }
        try {
            JsonNode page = MODEL_PROBE.get()
                    .uri(ANTHROPIC_MODELS_URL)
                    .header("x-api-key", key)
                    .header("anthropic-version", ANTHROPIC_VERSION)
                    .retrieve().body(JsonNode.class);
            List<String> ids = new ArrayList<>();
            if (page != null && page.has("data")) {
                for (JsonNode entry : page.get("data")) {
                    String id = entry.path("id").asText("");
                    if (!id.isBlank()) {
                        ids.add(id);
                    }
                }
            }
            return ids.isEmpty() ? ANTHROPIC_MODELS : ids;
        } catch (Exception apiUnreachable) {
            return ANTHROPIC_MODELS;
        }
    }

    /**
     * Asks the configured (or default localhost) Ollama for its installed models.
     *
     * @return the tag names from /api/tags, or empty when Ollama is unreachable
     *         or answers garbage — the picker then keeps its free-text fallback
     */
    private List<String> ollamaModels() {
        try {
            SpectroConfig c = SpectroConfig.load(SpectroConfig.Overrides.none());
            String base = (c.baseUrl() == null || c.baseUrl().isBlank()) ? "http://localhost:11434" : c.baseUrl();
            JsonNode tags = MODEL_PROBE.get()
                    .uri(base + "/api/tags").retrieve().body(JsonNode.class);
            List<String> names = new ArrayList<>();
            if (tags != null && tags.has("models")) {
                for (JsonNode entry : tags.get("models")) {
                    String name = entry.path("name").asText("");
                    if (!name.isBlank()) {
                        names.add(name);
                    }
                }
            }
            return names;
        } catch (Exception ollamaDown) {
            return List.of(); // ollama unreachable → empty; the client keeps free-text
        }
    }

    /**
     * Generated images. The store is content-addressed, so the file
     * name IS the contract: 64 hex chars + a known image extension — anything
     * else is rejected before it can reach the file system (tool inputs and
     * URLs are untrusted; no traversal, no probing).
     */
    private static final Pattern IMAGE_NAME = Pattern.compile("[0-9a-f]{64}\\.(png|jpg|webp)");

    /**
     * Serves one generated image from the content-addressed store under
     * {@code ~/.spectro/images}.
     *
     * @param file the bare file name — must match the 64-hex-plus-extension contract
     * @return 200 with the image bytes and matching content type; 400 for a name
     *         outside the contract, 404 when the file is missing or unreadable
     */
    @GetMapping("/api/images/{file}")
    public ResponseEntity<byte[]> image(@PathVariable String file) {
        if (!IMAGE_NAME.matcher(file).matches()) {
            return ResponseEntity.badRequest().build();
        }
        Path path = Path.of(System.getProperty("user.home"), ".spectro", "images", file);
        if (!Files.isRegularFile(path)) {
            return ResponseEntity.notFound().build();
        }
        MediaType type = switch (file.substring(file.lastIndexOf('.') + 1)) {
            case "jpg" -> MediaType.IMAGE_JPEG;
            case "webp" -> MediaType.parseMediaType("image/webp");
            default -> MediaType.IMAGE_PNG;
        };
        try {
            return ResponseEntity.ok().contentType(type).body(Files.readAllBytes(path));
        } catch (Exception unreadable) {
            return ResponseEntity.notFound().build();
        }
    }

    /**
     * The scheduler's job-state map (the same data `spectroscope cron status` prints).
     * The desktop shell polls this every 30 s and raises a native
     * notification when a job's status changes.
     *
     * @return job name → state, empty when the state file is absent or corrupt
     */
    @GetMapping("/api/jobs/state")
    public Map<String, JobState> jobsState() {
        Path path = Path.of(System.getProperty("user.home"), ".spectro", "jobs-state.json");
        if (!Files.exists(path)) {
            return Map.of();
        }
        try {
            ObjectMapper mapper = new ObjectMapper();
            return mapper.readValue(Files.readString(path),
                    mapper.getTypeFactory().constructMapType(
                            LinkedHashMap.class, String.class, JobState.class));
        } catch (Exception broken) {
            return Map.of(); // a corrupt state file does not break the poller
        }
    }
}
