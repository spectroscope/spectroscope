package dev.spectroscope.server.session;

import com.fasterxml.jackson.annotation.JsonInclude;
import com.fasterxml.jackson.annotation.JsonUnwrapped;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import dev.spectroscope.core.config.SpectroConfig;
import dev.spectroscope.core.events.RunEvent;
import dev.spectroscope.core.provider.LlmProvider;
import dev.spectroscope.core.scheduler.JobState;
import dev.spectroscope.core.session.SessionStore;
import dev.spectroscope.core.web.WebSearchTiers;
import dev.spectroscope.server.DotEnvSettings;
import dev.spectroscope.server.leveling.ServerLeveling;
import dev.spectroscope.server.providers.ListResult;
import dev.spectroscope.server.providers.ModelLists;
import dev.spectroscope.server.providers.ProviderRegistry;
import dev.spectroscope.server.shell.HelperPtyProvider;
import dev.spectroscope.server.shell.Shells;
import dev.spectroscope.server.web.LocalOrigin;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PatchMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;
import jakarta.servlet.http.HttpServletRequest;

import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.function.Function;
import java.util.regex.Pattern;

/**
 * The REST endpoints alongside the socket. The session endpoints read the
 * SAME JSONL store the CLI writes, so file, socket and REST all speak the one
 * RunEvent format. They never write a session file: the one destructive call
 * deletes a stored session, and since card 445 a session's title and pin are
 * written to {@link SessionMetaStore}, beside the sessions (the socket carries
 * every run-time mutation).
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
     * One row of the sidebar list: the session's own facts from the JSONL
     * store, and beside them what the operator said about the session (card
     * 445). The session fields stay at the top level of the JSON, so every
     * reader of the list from before this card reads it unchanged; the three
     * new fields are left out when a session has none of them.
     *
     * @param info        the session's facts, folded from its JSONL file
     * @param title       the title the row shows instead of the first prompt, or null
     * @param titleSource {@code suggested} or {@code manual}, null without a title
     * @param pinned      true for a pinned session, null otherwise
     */
    public record SessionRow(
            @JsonUnwrapped SessionStore.SessionInfo info,
            @JsonInclude(JsonInclude.Include.NON_NULL) String title,
            @JsonInclude(JsonInclude.Include.NON_NULL) String titleSource,
            @JsonInclude(JsonInclude.Include.NON_NULL) Boolean pinned) {}

    private final SessionMetaStore meta;
    private final SessionTitles titles;
    private final Function<SpectroConfig, LlmProvider> providers;

    /** Spring wiring: the shared meta store and the server's provider construction. */
    public SessionsController() {
        this(SessionMetaStore.shared(), SessionTitles.shared(), ServerProviders::build);
    }

    /**
     * Seam for tests.
     *
     * @param meta      where titles and pins live
     * @param titles    asks a model for a title
     * @param providers builds a provider for a session's recorded provider and model
     */
    SessionsController(SessionMetaStore meta, SessionTitles titles,
                       Function<SpectroConfig, LlmProvider> providers) {
        this.meta = meta;
        this.titles = titles;
        this.providers = providers;
    }

    /**
     * The sidebar list.
     *
     * @return every stored session's metadata, straight from the JSONL store,
     *         with its title and pin from the meta store (card 445)
     */
    @GetMapping("/api/sessions")
    public List<SessionRow> sessions() {
        Map<String, SessionMetaStore.Entry> said = meta.all();
        return SessionStore.listSessions().stream()
                .map(info -> {
                    SessionMetaStore.Entry entry = said.get(info.id());
                    return entry == null
                            ? new SessionRow(info, null, null, null)
                            : new SessionRow(info, entry.title(), entry.titleSource(),
                                    entry.pinned() ? Boolean.TRUE : null);
                })
                .toList();
    }

    /**
     * Card 445: renames or pins one stored session. The session file is not
     * touched; the change goes to the meta store.
     *
     * <p>The body carries {@code title} (a string; blank clears a hand-set
     * title, and the row falls back to the suggestion or the first prompt),
     * {@code pinned} (a boolean), or both. Behind the host fence every
     * {@code /api} path has ({@code ApiLocalFence}), plus the Origin check the
     * other writing endpoints carry.</p>
     *
     * @param id      the session id, shape-checked before anything else
     * @param body    the change
     * @param request the servlet request, for the Origin check
     * @return 200 with the session's {@code title}, {@code titleSource} and
     *         {@code pinned} after the change; 400 for a malformed id or body;
     *         404 for a foreign page or a session that is not stored
     */
    @PatchMapping(value = "/api/sessions/{id}", consumes = MediaType.APPLICATION_JSON_VALUE)
    public ResponseEntity<Map<String, Object>> patchSession(@PathVariable String id,
                                                            @RequestBody(required = false) JsonNode body,
                                                            HttpServletRequest request) {
        if (!LocalOrigin.originIsLoopbackOrAbsent(request)) {
            return ResponseEntity.notFound().build();
        }
        if (!SESSION_ID.matcher(id).matches()) {
            return ResponseEntity.badRequest().build();
        }
        if (body == null || !body.isObject()) {
            return ResponseEntity.badRequest().build();
        }
        JsonNode title = body.get("title");
        JsonNode pinned = body.get("pinned");
        boolean hasTitle = title != null && !title.isNull();
        boolean hasPin = pinned != null && !pinned.isNull();
        if ((!hasTitle && !hasPin) || (hasTitle && !title.isTextual()) || (hasPin && !pinned.isBoolean())) {
            return ResponseEntity.badRequest().build();
        }
        if (!isStored(id)) {
            return ResponseEntity.notFound().build();
        }
        if (hasTitle) {
            meta.rename(id, title.asText());
        }
        if (hasPin) {
            meta.pin(id, pinned.asBoolean());
        }
        return ResponseEntity.ok(said(meta.get(id)));
    }

    /**
     * Card 445, criterion 8: asks the session's own provider and model for a
     * title, once, from its first prompt. The menu offers it for sessions
     * without a title; nothing calls it for the whole list.
     *
     * <p>The request is the one a new session's first run makes
     * ({@link SessionTitles}), bounded by the same time limit. A session the
     * operator named by hand is not sent to the model. A failure is no error:
     * the answer says {@code suggested: false} and the row keeps what it had.</p>
     *
     * @param id      the session id, shape-checked before anything else
     * @param request the servlet request, for the Origin check
     * @return 200 with the session's title fields and {@code suggested}; 400 for
     *         a malformed id; 404 for a foreign page or a session not stored
     */
    @PostMapping("/api/sessions/{id}/title/suggest")
    public ResponseEntity<Map<String, Object>> suggestTitle(@PathVariable String id, HttpServletRequest request) {
        if (!LocalOrigin.originIsLoopbackOrAbsent(request)) {
            return ResponseEntity.notFound().build();
        }
        if (!SESSION_ID.matcher(id).matches()) {
            return ResponseEntity.badRequest().build();
        }
        SessionStore.SessionInfo info = SessionStore.listSessions().stream()
                .filter(row -> row.id().equals(id))
                .findFirst()
                .orElse(null);
        if (info == null) {
            return ResponseEntity.notFound().build();
        }
        SpectroConfig config = configFor(info);
        java.util.Optional<SessionMetaStore.Entry> before = meta.get(id);
        java.util.Optional<SessionMetaStore.Entry> after =
                titles.suggestNow(id, info.firstPrompt(), () -> providers.apply(config));
        Map<String, Object> out = said(after.isPresent() ? after : before);
        boolean suggested = after.isPresent() && SessionMetaStore.SUGGESTED.equals(after.get().titleSource())
                && !after.equals(before);
        out.put("suggested", suggested);
        return ResponseEntity.ok(out);
    }

    /**
     * The config for a session's recorded provider and model; the server's own
     * config when the session recorded none.
     */
    private static SpectroConfig configFor(SessionStore.SessionInfo info) {
        String provider = info.provider();
        if (provider == null || provider.isBlank() || "-".equals(provider)) {
            return SpectroConfig.load(SpectroConfig.Overrides.none());
        }
        String model = info.model() == null || info.model().isBlank() ? null : info.model();
        return SpectroConfig.load(new SpectroConfig.Overrides(provider, model, null, null, null, null));
    }

    /** Whether a session file exists for this (already shape-checked) id. */
    private static boolean isStored(String id) {
        try {
            return Files.isRegularFile(SessionStore.sessionFile(id));
        } catch (java.io.IOException outsideStore) {
            return false;
        }
    }

    /** The title fields of an entry as the PATCH and suggest answers carry them. */
    private static Map<String, Object> said(java.util.Optional<SessionMetaStore.Entry> entry) {
        Map<String, Object> out = new LinkedHashMap<>();
        entry.ifPresent(e -> {
            if (e.title() != null) {
                out.put("title", e.title());
                out.put("titleSource", e.titleSource());
            }
        });
        out.put("pinned", entry.map(SessionMetaStore.Entry::pinned).orElse(false));
        return out;
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

    /**
     * Export one stored session as a bundle (card 473): a zip with the session
     * file, its llm wire, its browser wire and its child session files, each
     * entry the file on disk byte for byte. The plain JSONL export above stays.
     *
     * <p>Fenced and shape-checked exactly like the plain export. The names
     * in the session's {@code run_start} reference are caller-shaped too, so
     * {@link SessionBundle} follows only plain basenames inside the
     * recorders' own folders.</p>
     *
     * @param id      the session to bundle
     * @param request the servlet request, for the local fence
     * @return 200 with a zip named {@code <id>.spectro.zip}; 404 for a foreign
     *         caller, a malformed id or a session that is not there
     */
    @GetMapping("/api/sessions/{id}/bundle")
    public ResponseEntity<org.springframework.web.servlet.mvc.method.annotation.StreamingResponseBody>
            exportBundle(@PathVariable String id, HttpServletRequest request) {
        if (!LocalOrigin.isLocalOrigin(request)
                || !LocalOrigin.originIsLoopbackOrAbsent(request)
                || !SESSION_ID.matcher(id).matches()) {
            return ResponseEntity.status(404).build();
        }
        try {
            if (!Files.isRegularFile(SessionStore.sessionFile(id))) {
                return ResponseEntity.status(404).build();
            }
            List<SessionBundle.Entry> entries = SessionBundle.entriesFor(id);
            // A zip is never rendered, and nosniff keeps a legacy sniffer from
            // promoting it. The id in the filename is safe by the shape check.
            return ResponseEntity.ok()
                    .contentType(new MediaType("application", "zip"))
                    .header("X-Content-Type-Options", "nosniff")
                    .header("Content-Disposition", String.format("attachment; filename=\"%s.spectro.zip\"", id))
                    .body(out -> SessionBundle.write(entries, out));
        } catch (java.io.IOException | RuntimeException unreadable) {
            return ResponseEntity.status(404).build();
        }
    }

    /** Session ids as the store mints them (yyyyMMdd-HHmmss-uuid8) plus the
     *  test/CLI-friendly general shape — never a path, never a dot. */
    private static final Pattern SESSION_ID = Pattern.compile("[A-Za-z0-9][A-Za-z0-9-]*");

    /**
     * Deletes one stored session: its JSONL file, its blob folder, its
     * sidecars, and since card 445 its title and pin. This is the one
     * deliberately destructive endpoint. Defense in depth: the id shape
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
            // Card 204, the fourth file of the family and the same contract: the
            // browser record holds every address the agent visited, so a deleted
            // session must not leave it lying in the home folder.
            boolean hadBrowser = Files.deleteIfExists(
                    dev.spectroscope.core.wire.BrowserWireRecorder.fileFor(id));
            // Card 445: the title and the pin are about this session and go
            // with it.
            boolean hadMeta = meta.remove(id);
            // Card 482: the playbook sidecar and this session's graph files go
            // with it. The dot in the name keeps a session whose id starts the
            // same way out of the match.
            boolean hadPlaybook = Files.deleteIfExists(
                    dev.spectroscope.core.playbook.run.PlaybookRecorder.fileFor(id));
            java.util.regex.Pattern own = java.util.regex.Pattern.compile(
                    java.util.regex.Pattern.quote(id) + "\\.[0-9a-f]{12}\\.graph\\.jsonl");
            Path runs = dev.spectroscope.core.playbook.run.PlaybookRecorder.folder();
            if (Files.isDirectory(runs)) {
                try (java.util.stream.Stream<Path> files = Files.list(runs)) {
                    for (Path f : files.filter(f -> own.matcher(f.getFileName().toString()).matches()).toList()) {
                        hadPlaybook |= Files.deleteIfExists(f);
                    }
                }
            }
            if (!hadSession && !hadWire && !hadBrowser && !hadMeta && !hadPlaybook) {
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
     * Card 379: whether rtk resolves where the agent's shell looks, and which
     * version answered.
     *
     * @param version what {@code rtk --version} printed, or null when rtk does
     *                not resolve
     * @return {@code available} and {@code version} for the popover
     */
    static Map<String, Object> rtkProbe(java.util.function.Supplier<String> version) {
        String found = version.get();
        Map<String, Object> rtk = new LinkedHashMap<>();
        rtk.put("available", found != null);
        rtk.put("version", found == null ? "" : found);
        return rtk;
    }

    /**
     * The onboarding word for one provider against the endpoint it would
     * really dial (D11, 2026-10-09): openai pointed at a private address with
     * no key is a local server, exactly as the doctor reports it, not a cloud
     * call missing its key.
     */
    static String statusOf(String provider, SpectroConfig c, boolean keyPresent) {
        if (SpectroConfig.presetEndpointFor(provider) == null) {
            return SpectroConfig.onboardingStatus(provider, keyPresent);
        }
        return SpectroConfig.onboardingStatusAt(provider, c.endpointFor(provider), keyPresent);
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
        // that will actually answer. A keyless backend reports "local" and the
        // client reads its reachability from the model list.
        //
        // Walked off SpectroConfig.knownProviders() rather than typed out. This
        // loop used to carry its own list of seven, so a provider added to the
        // config was offered by the picker and had no onboarding line at all —
        // and the comment above it named the local ones by hand, which made it
        // the third place the same list could go stale (card 312, round 3).
        Map<String, String> providerStatus = new LinkedHashMap<>();
        for (String p : SpectroConfig.knownProviders().stream().sorted().toList()) {
            if ("spectro-local".equals(p)) {
                // The built-in runtime is its own picker entry: keyless, and
                // "ready" once ANY catalogue model resolves (bundled or
                // downloaded), else "needs-download" (the picker opens the
                // chooser dialog). Never "needs-key", so it cannot answer the
                // key question the others answer.
                providerStatus.put(p,
                        SpectroConfig.localModelStatus(dev.spectroscope.core.local.LocalModel.anyPresent()));
                continue;
            }
            if (SpectroConfig.signsIn(p)) {
                // Card 496: a provider that signs in reports the stored sign-in,
                // read from the file alone: no runtime starts for a page load.
                providerStatus.put(p, SpectroConfig.onboardingStatus(p,
                        dev.spectroscope.core.copilot.CopilotAccount.forThisMachine().hasStoredSignIn()));
                continue;
            }
            String keyEnv = SpectroConfig.keyEnvFor(p);
            providerStatus.put(p, statusOf(p, c, keyEnv != null && envKeySet(keyEnv)));
        }
        out.put("providerStatus", providerStatus);
        // Card 379: the popover prints the version the binary printed, and when
        // rtk does not resolve it renders the row disabled with the reason
        // instead of hiding the switch.
        out.put("rtk", rtkProbe(dev.spectroscope.core.tools.RtkFilter::installedVersion));
        // Card 193: the address each LOCAL-MODEL provider would dial — the same
        // endpointFor the model-list probe itself uses, so the settings page's
        // address field and the "backend not reachable" sentence can name the
        // exact endpoint that was tried, never a guess. The set is
        // SpectroConfig.keylessLocalServers() and is no longer three literal
        // puts: a fourth keyless local backend gets its address here the day it
        // is declared, instead of the day the addressless sentence is noticed.
        Map<String, String> providerAddress = new LinkedHashMap<>();
        for (String p : SpectroConfig.keylessLocalServers().stream().sorted().toList()) {
            providerAddress.put(p, c.endpointFor(p));
        }
        out.put("providerAddress", providerAddress);
        // Card 203: which web_search tier answers on this machine, straight
        // from the ONE resolver. The settings page renders this; it does not
        // re-derive it, because a rule written a second time in TypeScript is
        // the same defect this card removed from the doctor. Keys travel as
        // PRESENCE only — same rule as the provider block above.
        WebSearchTiers.Choice searchTier = WebSearchTiers.forConfig(c);
        Map<String, Object> webSearch = new LinkedHashMap<>();
        webSearch.put("tier", searchTier.tier());
        webSearch.put("label", WebSearchTiers.label(searchTier.tier()));
        webSearch.put("detail", WebSearchTiers.describe(searchTier));
        // An address, not a credential: the settings field prefills from it.
        webSearch.put("searxngUrl", c.searxngUrl() == null ? "" : c.searxngUrl());
        webSearch.put("tavilyKey",
                String.valueOf(SpectroConfig.hasApiKey(WebSearchTiers.TAVILY_KEY_ENV)));
        webSearch.put("braveKey",
                String.valueOf(SpectroConfig.hasApiKey(WebSearchTiers.BRAVE_KEY_ENV)));
        out.put("webSearch", webSearch);
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
        // Two vocabularies, one write. LLM backends first, then the keyed WEB
        // SEARCH providers (card 203) — Tavily and Brave need a UI field like
        // every other key, and duplicating the 0600 write and its two fences in
        // a second endpoint would be duplicating exactly the parts that are
        // load-bearing. They stay OUT of keyEnvFor: an LLM vocabulary entry
        // would offer "tavily" in the model picker.
        String provider = body == null ? null : body.provider();
        String keyEnv = SpectroConfig.keyEnvFor(provider);
        if (keyEnv == null) {
            keyEnv = SpectroConfig.searchKeyEnvFor(provider);
        }
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
        // The registry's signature sees a key appear or vanish, not one key
        // replaced by another, so a save drops the stored answer for that provider.
        ProviderRegistry.shared().invalidate(provider);
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
        // A written name that is a provider's key variable drops that provider's stored answer.
        for (String known : SpectroConfig.knownProviders()) {
            if (name.equals(SpectroConfig.keyEnvFor(known))) {
                ProviderRegistry.shared().invalidate(known);
            }
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

    /**
     * Which wire a provider's model list is read on (card 472). Anthropic and
     * ollama have their own; every provider the harness counts as OpenAI
     * compatible ({@link SpectroConfig#openAiCompatProviders()}) is read on the
     * OpenAI one, so a provider added to that rule lists its models here
     * without a second edit.
     *
     * @param provider     the provider name
     * @param openAiCompat whether a provider speaks the OpenAI wire
     * @return {@code anthropic}, {@code ollama}, {@code openai}, or null for a
     *         provider without a model list
     */
    static String modelWire(String provider, java.util.function.Predicate<String> openAiCompat) {
        if ("anthropic".equals(provider) || "ollama".equals(provider)
                || dev.spectroscope.core.copilot.CopilotRuntime.PROVIDER.equals(provider)) {
            return provider;
        }
        return provider != null && openAiCompat.test(provider) ? "openai" : null;
    }

    /**
     * Model names for the header picker's per-provider dropdown. The switch
     * below has three arms because there are three WIRE PROTOCOLS, not because
     * there are three backends — every provider in
     * {@link SpectroConfig#openAiCompatProviders()} shares the third one, and
     * this comment named three while the arm already carried five (card 312):
     *
     * <ul>
     *   <li>ollama, from its /api/tags — the models actually installed;</li>
     *   <li>anthropic, from its Models API — what the key can use;</li>
     *   <li>the OpenAI-compatible ones, from the EFFECTIVE base URL's
     *       /v1/models: api.openai.com when a key rides the untouched default,
     *       otherwise whatever endpoint that provider is configured with. Both
     *       local servers answer it keyless, and a llama-server answers with
     *       the single model it was started on.</li>
     * </ul>
     *
     * <p>Curated lists remain the fallback. The empty answer is not reserved
     * for unknown names: spectro-local is a known provider and answers empty
     * on purpose — the bundled runtime's model is the download chooser's
     * question, not a dropdown's.</p>
     *
     * @param provider a provider name; ollama, anthropic and every member of
     *        {@link SpectroConfig#openAiCompatProviders()} have an arm — held to
     *        that set by {@code LlamaCppReachesTheFacesTest}, which dials each
     *        one — and everything else answers empty, spectro-local included,
     *        which speaks the same wire but is a subprocess with no endpoint to
     *        ask ({@code endpointFor} refuses it). The names the config accepts
     *        at all are {@link SpectroConfig#KNOWN_PROVIDERS_DISPLAY}
     * @return the model ids, or an empty list
     */
    @GetMapping("/api/models")
    public List<String> models(@RequestParam(name = "provider", defaultValue = "") String provider) {
        String wire = modelWire(provider, SpectroConfig.openAiCompatProviders()::contains);
        if (wire == null) {
            return List.of();
        }
        return switch (wire) {
            case "anthropic" -> anthropicModels();
            case "ollama" -> ollamaModels();
            case dev.spectroscope.core.copilot.CopilotRuntime.PROVIDER -> copilotModels();
            default -> openaiModels(provider);
        };
    }

    /**
     * The Copilot runtime's own model list (card 496), in its order. A runtime
     * a chat already started answers it; with none, the account starts one for
     * the question and stops it again ({@code CopilotAccount.askRuntime}), so
     * opening the picker or the settings leaves no runtime behind. Empty
     * without a stored sign-in, so a picker that only looks starts no runtime,
     * and empty when the runtime is missing or refuses.
     *
     * @return the model ids, or an empty list
     */
    private List<String> copilotModels() {
        dev.spectroscope.core.copilot.CopilotAccount account =
                dev.spectroscope.core.copilot.CopilotAccount.forThisMachine();
        return copilotModels(account.hasStoredSignIn(), () -> account.askRuntime(
                SpectroConfig.defaultModelFor(dev.spectroscope.core.copilot.CopilotRuntime.PROVIDER),
                dev.spectroscope.core.copilot.CopilotRuntime.find(null).requirePath(),
                provider -> provider.models().stream()
                        .map(dev.spectroscope.core.provider.CopilotProvider.CopilotModel::id)
                        .toList()));
    }

    /**
     * The Copilot model list's rule, apart from the runtime: without a stored
     * sign-in the runtime is not asked; a runtime that is missing or refuses
     * gives an empty list.
     *
     * @param signedIn whether a sign-in is stored
     * @param runtime  asks the runtime for its model ids
     * @return the model ids, or an empty list
     */
    static List<String> copilotModels(boolean signedIn, java.util.function.Supplier<List<String>> runtime) {
        if (!signedIn) {
            return List.of();
        }
        try {
            return runtime.get();
        } catch (RuntimeException unavailable) {
            org.slf4j.LoggerFactory.getLogger(SessionsController.class).debug("copilot: no model list", unavailable);
            return List.of();
        }
    }

    /**
     * Asks the EFFECTIVE endpoint of ONE OpenAI-compatible provider for its
     * models — live like the other two routes: api.openai.com when a key rides
     * the untouched default (Bearer attached), otherwise whatever host that
     * provider is configured with, which the keyless local servers answer
     * without a Bearer at all. Non-chat families are filtered, newest first;
     * a failure falls back to the curated list, and only openai has one.
     *
     * @param provider the OpenAI-compatible provider whose endpoint to ask
     * @return chat-capable model ids, newest first, or the curated fallback
     */
    private List<String> openaiModels(String provider) {
        // Curated fallback ONLY for real OpenAI: gpt-4o etc. are its models.
        // Every OTHER provider on this route that isn't answering returns EMPTY,
        // so the picker says 'not reachable' instead of showing a misleading
        // OpenAI list for a server that serves whatever you loaded into it.
        List<String> fallback = "openai".equals(provider) ? OPENAI_MODELS : List.of();
        try {
            SpectroConfig c = SpectroConfig.load(SpectroConfig.Overrides.none());
            String key = SpectroConfig.resolveApiKey(SpectroConfig.keyEnvFor(provider));
            // endpointFor resolves a per-provider address where one is declared
            // (card 193) and keeps the legacy shared rule for the cloud providers.
            ListResult r = ModelLists.openAiCompat(provider, c.endpointFor(provider), key);
            return r.isOk() && !r.models().isEmpty() ? r.models() : fallback;
        } catch (Exception configUnreadable) {
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
        ListResult r = ModelLists.anthropic(SpectroConfig.resolveApiKey("ANTHROPIC_API_KEY"));
        return r.isOk() && !r.models().isEmpty() ? r.models() : ANTHROPIC_MODELS;
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
            // preset last: the same endpointFor chain the provider itself dials
            // (card 193), so the probe can never test a different server than
            // the one a run would talk to.
            ListResult r = ModelLists.ollama(c.endpointFor("ollama"));
            return r.isOk() ? r.models() : List.of();
        } catch (Exception configUnreadable) {
            return List.of(); // the client keeps free-text
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
     * The scheduler's job-state map (the same data `spectroscope cron status` prints),
     * plus the code graph builds of this server process under {@code codegraph:<folder>}
     * (card 472), whose status is {@code running} while they build.
     * The desktop shell polls this every 30 s and raises a native
     * notification when a job's status changes.
     *
     * @return job name → state, the scheduler's part empty when its state file
     *         is absent or corrupt
     */
    @GetMapping("/api/jobs/state")
    public Map<String, JobState> jobsState() {
        return dev.spectroscope.server.codegraph.CodeGraphJobs.withCodeGraphJobs(
                schedulerJobsState(), dev.spectroscope.server.codegraph.CodeGraphJobs.shared());
    }

    /** The scheduler's own file, empty when it is absent or corrupt. */
    private static Map<String, JobState> schedulerJobsState() {
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
