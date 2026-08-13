package dev.spectroscope.server.session;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import dev.spectroscope.core.config.SpectroConfig;
import dev.spectroscope.core.events.RunEvent;
import dev.spectroscope.core.scheduler.JobState;
import dev.spectroscope.core.session.SessionStore;
import dev.spectroscope.server.DotEnvSettings;
import dev.spectroscope.server.leveling.ServerLeveling;
import dev.spectroscope.server.shell.HelperPtyProvider;
import dev.spectroscope.server.shell.Shells;
import dev.spectroscope.server.web.LocalOrigin;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;
import jakarta.servlet.http.HttpServletRequest;
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
 *
 * <p>No {@code @CrossOrigin}: the production UI is served from this same jar
 * (same origin) and {@code spectro-web/vite.config.ts} proxies {@code /api} to
 * the boot server, so the dev server's browser requests are same-origin too. A
 * wildcard read-CORS here let any page the operator visited harvest session
 * content (prompts, tool output) and the content-addressed image names — the
 * amplifier the 0.3.0 adversarial pass named. Dropped, matching the settings
 * and probe controllers. The image byte serve additionally wears the
 * loopback+Host read fence against DNS rebinding.</p>
 */
@RestController
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
     * The id becomes a file name, so it wears the same shape check as export
     * and delete (full-match: no separator, no dot can pass); the store's
     * containment check backs it up underneath.
     *
     * @param id the session id whose JSONL file is read
     * @return 200 with every parsed RunEvent; 404 when the id is not a session
     *         id or the session cannot be read
     */
    @GetMapping("/api/sessions/{id}/events")
    public ResponseEntity<List<RunEvent>> events(@PathVariable String id) {
        if (!SESSION_ID.matcher(id).matches()) {
            return ResponseEntity.notFound().build();
        }
        try {
            return ResponseEntity.ok(SessionStore.readSessionEvents(id));
        } catch (Exception missing) {
            return ResponseEntity.notFound().build();
        }
    }

    /**
     * Export one stored session as its RAW JSONL — the mirror of the existing
     * import, so a session can leave the machine and come back byte-identical.
     * The file is served verbatim (no re-serialization), as a download.
     *
     * <p>Fenced like every local endpoint, and the id is shape-checked BEFORE
     * it becomes a file name — it is the one piece of caller input that
     * touches the path.
     *
     * @param id      the session to export
     * @param request the servlet request, for the local fence
     * @return 200 with the JSONL body; 404 for a foreign caller, a malformed
     *         id or a session that is not there
     */
    @GetMapping("/api/sessions/{id}/export")
    public ResponseEntity<String> exportSession(@PathVariable String id, HttpServletRequest request) {
        if (!LocalOrigin.isLocalOrigin(request)
                || !LocalOrigin.originIsLoopbackOrAbsent(request)
                || !SESSION_ID.matcher(id).matches()) {
            return ResponseEntity.status(404).build();
        }
        try {
            // Defense in depth: the store's ONE containment check (normalized,
            // direct child of SESSIONS_DIR) — it throws for anything outside.
            Path file = SessionStore.sessionFile(id);
            if (!Files.isRegularFile(file)) {
                return ResponseEntity.status(404).build();
            }
            String jsonl = Files.readString(file);
            // The body is stored session content = caller-shaped text. Serve it
            // as a download with a non-HTML type and nosniff, so it can never
            // reach an HTML parsing context on this origin. The id in the
            // filename is safe by the shape check above: [A-Za-z0-9-] carries
            // no quote, CR or LF.
            return ResponseEntity.ok()
                    .contentType(new MediaType("application", "x-ndjson",
                            java.nio.charset.StandardCharsets.UTF_8))
                    .header("X-Content-Type-Options", "nosniff")
                    .header("Content-Disposition", "attachment; filename=\"" + id + ".jsonl\"")
                    .body(jsonl);
        } catch (java.io.IOException unreadable) {
            return ResponseEntity.status(404).build();
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
            // The cascade runs UNCONDITIONALLY: "delete whatever this id left
            // behind" is the honest contract. Gating the sidecar on the session
            // file's existence stranded two real cases (card 184 review): the
            // stt day files, which never have a session, and an orphaned
            // sidecar after a half-failed earlier delete.
            boolean hadSession = SessionStore.deleteSession(id);
            boolean hadWire = Files.deleteIfExists(
                    dev.spectroscope.core.wire.LlmWireRecorder.fileFor(id));
            if (!hadSession && !hadWire) {
                return ResponseEntity.notFound().build();
            }
            return ResponseEntity.noContent().build();
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
    public Map<String, Object> config() {
        SpectroConfig c = SpectroConfig.load(SpectroConfig.Overrides.none());
        Map<String, Object> out = new LinkedHashMap<>();
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
        // Onboarding status per LLM provider (presence only, never values): the
        // picker shows an honest "needs-key — add it to .env" line instead of a
        // fake model list, and the first-run dialog points people at a backend
        // that will actually answer. Local backends (ollama/lmstudio) report
        // "local"; the client reads their reachability from the model list.
        Map<String, String> providerStatus = new LinkedHashMap<>();
        for (String p : List.of("anthropic", "openai", "openrouter", "gemini", "ollama", "lmstudio")) {
            String keyEnv = SpectroConfig.keyEnvFor(p);
            providerStatus.put(p, SpectroConfig.onboardingStatus(p, keyEnv != null && envKeySet(keyEnv)));
        }
        // The built-in local provider is its own picker entry: keyless, and
        // "ready" once ANY catalogue model resolves (bundled or downloaded), else
        // "needs-download" (the picker opens the chooser dialog). Never "needs-key".
        providerStatus.put("spectro-local",
                SpectroConfig.localModelStatus(dev.spectroscope.core.local.LocalModel.anyPresent()));
        out.put("providerStatus", providerStatus);
        // Card 193: the address each LOCAL-MODEL provider would dial — the same
        // endpointFor the model-list probe itself uses, so the settings page's
        // address field and the "backend not reachable" sentence can name the
        // exact endpoint that was tried, never a guess.
        Map<String, String> providerAddress = new LinkedHashMap<>();
        providerAddress.put("ollama", c.endpointFor("ollama"));
        providerAddress.put("lmstudio", c.endpointFor("lmstudio"));
        out.put("providerAddress", providerAddress);
        // Whether this install HAS a terminal, and if not, which of the two
        // reasons it is. The pane used to offer the toggle unconditionally and
        // then print "the server refused the connection" when the socket closed
        // — technically true and useless: a plain `java -jar` has no terminal by
        // construction, because the `spectro-pty` helper rides the signed
        // desktop bundle and is not in this jar. Saying WHY before the press is
        // the same rule the fleet lobby's spawn button already follows.
        out.put("shell", shellStatus());
        // Leveling's one server-established criterion: a configured provider that
        // reports ready settles provider-ready. "local" is deliberately NOT enough —
        // it says a backend is configured, not that it answers; the client reports
        // reachability, and a completed run settles it either way.
        if (providerStatus.containsValue("ready")) {
            ServerLeveling.recorder().establish("provider-ready", System.currentTimeMillis());
        }
        return out;
    }

    /**
     * Save an API key from the onboarding UI — LOCAL browsers only. Security:
     * {@code consumes=json} makes a cross-origin POST a CORS preflight the policy
     * rejects, and a non-local {@code Host} answers 404 ({@link LocalOrigin#isLocalOrigin});
     * both together block a malicious page from writing the key. It lands in
     * {@code ~/.spectro/.env} at 0600, which the provider build reads on the next
     * fresh chat — no restart. Presence-only: the value is never echoed back and
     * never enters a log or a GET.
     *
     * @param body    the provider and its key
     * @param request the servlet request, for the local-origin check
     * @return 200 {@code {saved:true}} · 400 on an unknown provider or empty key · 404 when not local
     */
    @PostMapping(value = "/api/onboarding/key", consumes = MediaType.APPLICATION_JSON_VALUE)
    public ResponseEntity<Map<String, Object>> saveKey(@RequestBody(required = false) KeyBody body,
                                                       HttpServletRequest request) {
        // Two fences: isLocalOrigin blocks a remote/rebinding caller, and the
        // Origin check blocks CSRF from a real website. Both are kept belt-and-
        // braces even though the controller-wide @CrossOrigin(*) is now gone: a
        // same-origin page and the Vite dev proxy send a loopback Origin; a
        // non-browser client sends none; a cross-site page is refused.
        if (!LocalOrigin.isLocalOrigin(request) || !LocalOrigin.originIsLoopbackOrAbsent(request)) {
            return ResponseEntity.notFound().build();
        }
        String keyEnv = body == null ? null : SpectroConfig.keyEnvFor(body.provider());
        if (keyEnv == null) {
            return ResponseEntity.badRequest().body(Map.of("error", "unknown provider, or it needs no key"));
        }
        if (body.key() == null || body.key().isBlank()) {
            return ResponseEntity.badRequest().body(Map.of("error", "empty key"));
        }
        try {
            SpectroConfig.writeApiKey(keyEnv, body.key().trim());
        } catch (Exception writeFailed) {
            return ResponseEntity.internalServerError().body(Map.of("error", "could not save the key"));
        }
        return ResponseEntity.ok(Map.of("saved", true, "provider", body.provider()));
    }

    /**
     * {@code GET /api/settings/env}: the operator settings the UI may save, and
     * what they are set to now.
     *
     * <p>Not secrets, unlike the keys next door: a port number and a boolean,
     * both of which the operator is about to edit. The value is reported so the
     * page can show what is in force rather than an empty box that looks unset.
     * Only {@link DotEnvSettings#WRITABLE} is ever read or reported.</p>
     *
     * @param request the servlet request, for the fences
     * @return the current values, and whether each came from the process
     *         environment (which the UI cannot change) or from the file
     */
    @GetMapping("/api/settings/env")
    public ResponseEntity<Map<String, Object>> operatorSettings(HttpServletRequest request) {
        if (!LocalOrigin.isLocalOrigin(request)) {
            return ResponseEntity.notFound().build();
        }
        Map<String, Object> fromFile = DotEnvSettings.read(SpectroConfig.dotEnvPath());
        Map<String, Object> out = new LinkedHashMap<>();
        for (String name : DotEnvSettings.WRITABLE) {
            String live = System.getenv(name);
            boolean fromEnv = live != null && !live.isBlank();
            out.put(name, Map.of(
                    "value", fromEnv ? live : String.valueOf(fromFile.getOrDefault(name, "")),
                    // A real env var wins over the file for the whole process
                    // life, so the UI must say the box it is showing cannot take
                    // effect rather than let the operator type into it and wonder.
                    "fromEnvironment", fromEnv));
        }
        return ResponseEntity.ok(out);
    }

    /**
     * {@code POST /api/settings/env}: save one operator setting to
     * {@code ~/.spectro/.env}.
     *
     * <p>Same two fences as the key write, for the same reason and then one
     * more: {@code SPECTRO_ALLOW_SPAWN} is the switch that lets this server
     * start processes, so a cross-site page reaching it would be handing a
     * website the ability to arm process spawning on the operator's machine.
     * The UI asks the operator to confirm that one in words before it posts —
     * but the confirmation is a courtesy to the reader, and THIS fence is the
     * control.</p>
     *
     * <p>The allowlist is the security boundary. {@code ~/.spectro/.env} is read
     * by the launchers into the process environment, so an unrestricted writer
     * here would be remote code execution wearing a settings form: one
     * {@code JAVA_TOOL_OPTIONS} line and the next boot runs whatever it says.
     * Two names, both validated for shape, and nothing else is accepted.</p>
     *
     * @param body the setting to save
     * @param request the servlet request, for the fences
     * @return 404 for a refused caller, 400 for an unknown name or a value that
     *         is not the shape that name takes, else the saved value
     */
    @PostMapping(value = "/api/settings/env", consumes = MediaType.APPLICATION_JSON_VALUE)
    public ResponseEntity<Map<String, Object>> saveSetting(@RequestBody(required = false) SettingBody body,
                                                           HttpServletRequest request) {
        if (!LocalOrigin.isLocalOrigin(request) || !LocalOrigin.originIsLoopbackOrAbsent(request)) {
            return ResponseEntity.notFound().build();
        }
        String name = body == null ? null : body.name();
        if (name == null || !DotEnvSettings.WRITABLE.contains(name)) {
            return ResponseEntity.badRequest().body(Map.of("error", "not a settable name"));
        }
        String value = body.value() == null ? "" : body.value().trim();
        if (!validSetting(name, value)) {
            return ResponseEntity.badRequest().body(Map.of("error", "not a value this setting takes"));
        }
        try {
            SpectroConfig.writeApiKey(name, value); // same writer, same 0600 file
        } catch (Exception writeFailed) {
            return ResponseEntity.internalServerError().body(Map.of("error", "could not save the setting"));
        }
        // Honest about what just happened: the beans that read these are built
        // at boot, so the value is on disk and NOT in force until a restart.
        return ResponseEntity.ok(Map.of("saved", true, "name", name, "restartRequired", true));
    }

    /**
     * Whether a value is the shape its setting takes.
     *
     * <p>Blank is always allowed: it is how an operator turns an opt-in back
     * off, and both readers treat a blank as "off" already.</p>
     *
     * @param name the setting name, already known to be writable
     * @param value the trimmed value
     * @return true when it may be written
     */
    private static boolean validSetting(String name, String value) {
        if (value.isEmpty()) {
            return true;
        }
        if (DotEnvSettings.HUB_PORT.equals(name)) {
            // 0 is meaningful here: it binds an ephemeral loopback port.
            try {
                int port = Integer.parseInt(value);
                return port >= 0 && port <= 65535;
            } catch (NumberFormatException notAPort) {
                return false;
            }
        }
        // The reader treats anything but "true" as off; accepting only the two
        // words keeps the file readable and a typo visible instead of silently
        // meaning "off".
        return "true".equalsIgnoreCase(value) || "false".equalsIgnoreCase(value);
    }

    /** One operator setting to save. Not a key — these two are not secrets. */
    public record SettingBody(String name, String value) {}

    /**
     * What this install can offer as a terminal.
     *
     * @return {@code ready} when a PTY helper is present and shells are on,
     *         {@code off} when the operator turned them off, {@code unavailable}
     *         when this build simply has no helper — the plain-jar case
     */
    private static String shellStatus() {
        if (!Shells.enabled()) {
            return "off";
        }
        return new HelperPtyProvider().available() ? "ready" : "unavailable";
    }

    /** The save-key request body (never logged). */
    public record KeyBody(String provider, String key) {}

    /** Whether an env-provided key is present and non-blank — presence only,
     *  the value never leaves the process.
     *  @param name the environment variable to probe
     *  @return true when set and non-blank */
    private static boolean envKeySet(String name) {
        return SpectroConfig.hasApiKey(name); // env OR ~/.spectro/.env (keys saved from the UI)
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
            case "openai", "lmstudio", "openrouter", "gemini" -> openaiModels(provider);
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
        // Curated fallback ONLY for real OpenAI — gpt-4o etc. are its models. A
        // local (lmstudio) or gateway (openrouter) backend that isn't answering
        // returns EMPTY, so the picker says 'not reachable' instead of showing a
        // misleading OpenAI list for a server that serves whatever you loaded.
        List<String> fallback = "openai".equals(provider) ? OPENAI_MODELS : List.of();
        try {
            SpectroConfig c = SpectroConfig.load(SpectroConfig.Overrides.none());
            String key = SpectroConfig.resolveApiKey(SpectroConfig.keyEnvFor(provider));
            boolean hasKey = key != null && !key.isBlank();
            // endpointFor resolves lmstudio's own per-provider address (card 193)
            // and keeps the legacy shared rule for the cloud providers.
            String base = c.endpointFor(provider);

            RestClient.RequestHeadersSpec<?> request = MODEL_PROBE.get()
                    .uri(base + dev.spectroscope.core.provider.OpenAiCompatProvider.compatPath(base, "/models"));
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
            return ids.isEmpty() ? fallback : ids;
        } catch (Exception apiUnreachable) {
            return fallback;
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
        String key = SpectroConfig.resolveApiKey("ANTHROPIC_API_KEY");
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
            // The per-provider address first, the legacy baseUrl underneath, the
            // preset last — the same endpointFor chain the provider itself dials
            // (card 193), so the probe can never test a different server than
            // the one a run would talk to.
            String base = c.endpointFor("ollama");
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
     * {@code ~/.spectro/images}. Local-only: an image can carry sensitive
     * visual content, and its name is discoverable from the session events, so
     * the byte serve wears the loopback+Host fence (a rebound page fails the
     * Host check) rather than resting on name-obscurity. The UI's {@code <img>}
     * loads it same-origin and passes.
     *
     * @param file the bare file name — must match the 64-hex-plus-extension contract
     * @param request the servlet request, for the local-origin fence
     * @return 200 with the image bytes and matching content type; 400 for a name
     *         outside the contract, 404 for a non-local caller or a missing file
     */
    @GetMapping("/api/images/{file}")
    public ResponseEntity<byte[]> image(@PathVariable String file, HttpServletRequest request) {
        if (!LocalOrigin.isLocalOrigin(request)) {
            return ResponseEntity.notFound().build();
        }
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
