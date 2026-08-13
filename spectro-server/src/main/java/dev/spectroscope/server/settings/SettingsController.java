package dev.spectroscope.server.settings;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import dev.spectroscope.core.config.HookConfig;
import dev.spectroscope.core.config.SettingsWriter;
import dev.spectroscope.core.config.SpectroConfig;
import dev.spectroscope.core.config.WorkspaceResolver;
import dev.spectroscope.core.graph.Redaction;
import dev.spectroscope.core.hooks.HookRunner;
import dev.spectroscope.core.permission.Allowlist;
import dev.spectroscope.core.permission.ToolTier;
import dev.spectroscope.core.permission.ToolTierMap;
import dev.spectroscope.server.session.SessionWorkspaces;
import dev.spectroscope.server.web.LocalOrigin;
import jakarta.servlet.http.HttpServletRequest;
import org.springframework.http.HttpStatus;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PutMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.server.ResponseStatusException;

import java.io.IOException;
import java.nio.file.Path;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.function.Function;
import java.util.regex.Pattern;

/**
 * The settings API — the read side. One schema, several scopes, visible truth:
 * the merged view plus per-field provenance, the raw non-empty layers and the
 * concrete file paths. REST is read-only except the settings PUTs (Tasks 9/10).
 *
 * <p>Without {@code ?session=}, {@link #settings} answers the PROCESS-moment
 * view: no workspace scopes join the chain, {@code workspace} is {@code null}
 * in the answer, and {@code files} carries only the user and launch-dir paths.
 * With a session id, it answers the SESSION-moment view: that session's
 * workspace (a picked pin winning over the configured/env workspace, located
 * read-only via {@link WorkspaceResolver#locate} — nothing is created here)
 * joins the chain, and {@code files} gains the workspace's project and local
 * paths. A malformed id is refused before it ever reaches the pin lookup or
 * the filesystem; a session with neither a pin nor a configured workspace
 * answers 404 — the composer's settings gear renders disabled until then.</p>
 *
 * <p>No {@code @CrossOrigin}: unlike the other controllers here (kept for a
 * hypothetical direct dev-server hit), this one carries the PUT endpoints —
 * config that executes (hooks run, MCP processes spawn, gates can auto-allow).
 * {@code spectro-web/vite.config.ts} proxies {@code /api} to the boot server, so
 * the dev server's browser requests are same-origin already; the production
 * UI is served from the SAME origin as this API (one jar). A wildcard CORS
 * policy on writes that can change what the agent is allowed to do was
 * needless exposure with no matching need — narrowed per the final review.</p>
 *
 * <p>Beyond CORS, the whole API wears {@link LocalOrigin#isLocalOrigin}
 * against DNS rebinding — a rebound page's requests are same-origin to the
 * browser, so CORS never applies, and only the Host header betrays them. The
 * read side matters too: it echoes the effective config and the raw layers,
 * including {@code otlpBasicAuth} when configured. The PUTs additionally wear
 * the Origin fence, the same bar as the key writer.</p>
 */
@RestController
public class SettingsController {

    /** Session ids as the store mints them, plus the general test/CLI-friendly
     *  shape — never a path, never a dot (same rule as {@code SessionsController}
     *  and {@code WorkspaceController}). */
    private static final Pattern SESSION_ID = Pattern.compile("[A-Za-z0-9][A-Za-z0-9-]*");

    /** Reads one raw {@code hooks} entry into the core's own record, so the
     *  read-out and the runner agree about what an entry means. */
    private static final ObjectMapper JSON = new ObjectMapper();

    /** Workspace-local settings file, relative to the workspace root — now taken
     *  from {@code SpectroConfig} rather than spelled again here. It used to be a
     *  second copy of the literal because the original was package-private; card
     *  199's review found the cost of copies of this particular path (a whole
     *  folded allowlist layer that the migration never visited), so the copy is
     *  gone and there is one spelling. */
    private static final String WS_LOCAL_SETTINGS = SpectroConfig.WS_LOCAL_SETTINGS;

    private final Path launchDir;

    /** session id -> pinned workspace path, or {@code null} when unpinned;
     *  production wiring reads the shared, real {@link SessionWorkspaces} pin
     *  map, tests inject a fake so no real pin state is needed. */
    private final Function<String, String> workspacePin;

    /** session id -> the folder that session's run actually resolved, or
     *  {@code null} before the first run; the same record {@code /api/files}
     *  reads, so the Files tree and a settings write cannot disagree. */
    private final Function<String, String> workspaceResolved;

    /** Spring wiring: the launch dir is the server process's working directory;
     *  session pins and resolutions read the shared {@link SessionWorkspaces} map. */
    public SettingsController() {
        this(Path.of(System.getProperty("user.dir")),
                SessionWorkspaces::pinned, SessionWorkspaces::resolvedPath);
    }

    /**
     * Seam for tests, for a session that has not resolved a workspace yet.
     *
     * @param launchDir    the directory whose {@code .spectro/settings.json} forms
     *                     the launch-dir layer
     * @param workspacePin supplies a session's pinned workspace path, or {@code null}
     */
    SettingsController(Path launchDir, Function<String, String> workspacePin) {
        this(launchDir, workspacePin, session -> null);
    }

    /**
     * Seam for tests: the launch-dir layer's root and both workspace lookups are
     * injectable, so a test needs no real {@code SessionWorkspaces} state and
     * no real working directory.
     *
     * @param launchDir         the directory whose {@code .spectro/settings.json}
     *                          forms the launch-dir layer
     * @param workspacePin      supplies a session's pinned workspace path, or {@code null}
     * @param workspaceResolved supplies the folder that session's run resolved,
     *                          or {@code null} when no run has resolved one
     */
    SettingsController(Path launchDir, Function<String, String> workspacePin,
            Function<String, String> workspaceResolved) {
        this.launchDir = launchDir;
        this.workspacePin = workspacePin;
        this.workspaceResolved = workspaceResolved;
    }

    /**
     * {@code GET /api/settings[?session=]}: the effective configuration
     * alongside its provenance, the raw non-empty layers and the concrete
     * settings file paths — Task 13's web client consumes this shape verbatim.
     *
     * @param session optional session id; absent/blank answers the process-moment
     *                view, present answers that session's workspace-joined view
     * @return {@code effective} (the resolved config, every field, nulls
     *         included), {@code origins} (per-field winner + shadowed layers),
     *         {@code layers} (each non-empty scope's own settings as raw JSON),
     *         {@code files} (the concrete paths for this view) and
     *         {@code workspace} (the resolved directory, or {@code null} in the
     *         process-moment view)
     * @throws ResponseStatusException 400 for a malformed session id, 404 when
     *                                  the session has neither a pinned nor a
     *                                  configured workspace
     */
    @GetMapping("/api/settings")
    public Map<String, Object> settings(@RequestParam(value = "session", required = false) String session,
            HttpServletRequest request) {
        requireLocal(request, false);
        Path workspace = resolveWorkspace(session);
        SpectroConfig.Resolved resolved = SpectroConfig.loadResolved(
                SpectroConfig.Overrides.none(), launchDir, workspace);

        Map<String, Object> out = new LinkedHashMap<>();
        out.put("effective", resolved.config());
        out.put("origins", resolved.origins());
        out.put("layers", resolved.layers());
        out.put("files", files(workspace));
        out.put("workspace", workspace == null ? null : workspace.toString());
        return out;
    }

    /**
     * {@code GET /api/settings/allowlist}: the auto-approve allowlist READ OUT —
     * every entry with the tier it now carries, per scope and folded (card 199,
     * criterion 4).
     *
     * <p>This endpoint exists because the page must not re-decide anything. The
     * tier map ships in the jar, {@link Allowlist} parses the entry grammar, and
     * both live on this side of the wire; a settings page that re-implemented
     * either in TypeScript would drift from the gate the moment one of them
     * changed, and a permission page that disagrees with the gate is worse than
     * no page. So the server answers what it decided and the page renders it —
     * the same rule card 203's web-search block obeys.
     *
     * <p>Writes go through the existing {@code PUT /api/settings/{scope}} with an
     * {@code autoApprove} array. There is deliberately no write endpoint here:
     * one validated write path, not two.
     *
     * @param session optional session id — with it, the workspace scopes join
     * @param request the servlet request, for the local-origin fence
     * @return the map's schema and version, the readable tier names, the entries
     *         per scope and the folded effective list
     */
    @GetMapping("/api/settings/allowlist")
    public Map<String, Object> allowlist(
            @RequestParam(value = "session", required = false) String session,
            HttpServletRequest request) {
        requireLocal(request, false);
        Path workspace = resolveWorkspace(session);
        SpectroConfig.Resolved resolved = SpectroConfig.loadResolved(
                SpectroConfig.Overrides.none(), launchDir, workspace);
        ToolTierMap tiers = ToolTierMap.shipped();

        Map<String, Object> out = new LinkedHashMap<>();
        out.put("schemaVersion", tiers.schemaVersion());
        out.put("mapVersion", tiers.mapVersion());
        out.put("tiers", java.util.Arrays.stream(ToolTier.values()).map(ToolTier::wireName).toList());

        Map<String, Object> scopes = new LinkedHashMap<>();
        resolved.layers().forEach((layer, raw) -> {
            JsonNode entries = raw.path("autoApprove");
            if (entries.isArray()) {
                scopes.put(layer, readings(entries));
            }
        });
        out.put("scopes", scopes);
        out.put("effective",
                Allowlist.fromEntries(resolved.config().autoApprove(), tiers).readings());
        out.put("files", files(workspace));
        return out;
    }

    /** One layer's raw autoApprove array, read out through the gate's own parser. */
    private static java.util.List<Allowlist.EntryReading> readings(JsonNode array) {
        java.util.List<String> raw = new java.util.ArrayList<>();
        array.forEach(node -> raw.add(node.asText()));
        return Allowlist.fromEntries(raw, ToolTierMap.shipped()).readings();
    }

    /**
     * {@code GET /api/settings/hooks}: the configured shell hooks READ OUT — per
     * scope and folded, each with the matcher and the timeout it will ACTUALLY
     * run under (card 195).
     *
     * <p>This endpoint exists for the same reason the allowlist one above does:
     * so the page renders a decision instead of making one. Two defaults live in
     * the core — {@code matcherOrDefault()} turns an unset matcher into
     * {@code "*"}, and {@link HookRunner#DEFAULT_TIMEOUT_SECONDS} is what an
     * unset timeout becomes — and a page that worked either out again in
     * TypeScript would print the wrong number the day the runner's default moved.
     * So both are resolved here and both travel BESIDE the raw value, because a
     * page that showed only the resolved one could not tell an operator whether
     * a hook set its own timeout or inherited one.
     *
     * <p>{@code tier} is the honest label for what a hook IS, in card 199's own
     * vocabulary: {@link ToolTier#EVAL_EXECUTE}. A hook is arbitrary shell that
     * this product executes, and a {@code pre_tool_use} hook runs BEFORE the
     * permission gate, so it is not merely as wide as the widest tool — it is
     * that wide and ungated. The word is answered from the enum rather than
     * spelled in the page, so it moves with the enum.
     *
     * <p><b>{@code hooks} is a WHOLE-BLOCK field</b>, and that is the fact this
     * read-out exists to carry. The highest layer that sets {@code hooks}
     * REPLACES every layer below it (see {@code SpectroConfig.PartialConfig});
     * the layers do not add up. A page that listed the scopes and left the
     * reader to add them up would state the wrong guards with full confidence —
     * measured in a live session, where a workspace hook blocked every tool call
     * while the page listed a user hook that never ran. So {@code effective} is
     * the folded list a run would actually load, and {@code origin} names the
     * layer it came from plus the layers it silenced, read straight out of the
     * core's own provenance map rather than re-derived here.
     *
     * <p>{@code session} and {@code workspace} say WHICH run the answer is for.
     * Without a session id the workspace scopes never join the chain, so the
     * answer is machine-wide and the page has to be able to say so instead of
     * implying it describes the run in front of the reader.
     *
     * <p>The command is answered VERBATIM. It used to come back redacted, which
     * protected nothing and cost the page its write path: {@link #settings}
     * already echoes every layer's raw JSON — {@code hooks} included — to the
     * same browser over the same local-origin fence, so the same bytes were one
     * route away either way, while the page could no longer add or remove a hook
     * once one entry tripped a rule (an ordinary email address was enough).
     * {@link Redaction} still fires where it earns its keep, on the way into the
     * session file ({@code HookRunner.safe}), which is the artefact people
     * export. What survives here is a FORECAST of that, not a censorship of
     * this: {@code redactionRule} names the rule the run will replace this
     * command with, so an operator who later finds {@code [redacted: email]} in
     * a trace row can read on this page why, instead of taking it for a broken
     * hook.
     *
     * <p>Writes go through the existing {@code PUT /api/settings/{scope}} with a
     * {@code hooks} array — one validated write path, not two.
     *
     * @param session optional session id — with it, the workspace scopes join
     * @param request the servlet request, for the local-origin fence
     * @return the tier and the runner default, the two events that exist, the
     *         entries per scope, the folded effective list with the layer it
     *         came from, the run it was resolved for and the files
     */
    @GetMapping("/api/settings/hooks")
    public Map<String, Object> hooks(
            @RequestParam(value = "session", required = false) String session,
            HttpServletRequest request) {
        requireLocal(request, false);
        Path workspace = resolveWorkspace(session);
        SpectroConfig.Resolved resolved = SpectroConfig.loadResolved(
                SpectroConfig.Overrides.none(), launchDir, workspace);

        Map<String, Object> out = new LinkedHashMap<>();
        out.put("tier", ToolTier.EVAL_EXECUTE.wireName());
        out.put("defaultTimeoutSeconds", HookRunner.DEFAULT_TIMEOUT_SECONDS);
        out.put("events", HookConfig.EVENTS);

        Map<String, Object> scopes = new LinkedHashMap<>();
        resolved.layers().forEach((layer, raw) -> {
            JsonNode entries = raw.path("hooks");
            if (entries.isArray()) {
                scopes.put(layer, hookReadings(entries));
            }
        });
        out.put("scopes", scopes);
        out.put("effective", resolved.config().hooks().stream().map(SettingsController::reading).toList());
        out.put("origin", resolved.origins().get("hooks"));
        out.put("session", session == null || session.isBlank() ? null : session);
        out.put("workspace", workspace == null ? null : workspace.toString());
        out.put("files", files(workspace));
        return out;
    }

    /** One layer's raw {@code hooks} array, read out through the core's own record.
     *  <p>No per-entry rescue: {@link SpectroConfig#loadResolved} has parsed the
     *  same bytes through the same record and thrown before this method is ever
     *  reached, so a try/catch here would answer a state the server cannot
     *  produce. Malformed config fails loudly, and it fails on the way in.
     *  @param array the layer's raw hooks array
     *  @return the readings, in file order */
    private static java.util.List<Map<String, Object>> hookReadings(JsonNode array) {
        java.util.List<Map<String, Object>> out = new java.util.ArrayList<>();
        for (JsonNode node : array) {
            try {
                out.add(reading(JSON.treeToValue(node, HookConfig.class)));
            } catch (com.fasterxml.jackson.core.JsonProcessingException unreachable) {
                throw new IllegalArgumentException(unreachable.getMessage(), unreachable);
            }
        }
        return out;
    }

    /** One hook as the page needs it: what the file says, beside what it resolves to.
     *  @param hook the parsed entry
     *  @return the reading, ready to serialize */
    private static Map<String, Object> reading(HookConfig hook) {
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("event", hook.event());
        out.put("matcher", hook.matcherOrDefault());
        out.put("rawMatcher", hook.matcher());
        out.put("command", hook.command());
        // Not "this is hidden" but "this is what the run will hide": the SAME
        // table HookRunner.safe uses, asked one surface earlier, so a page can
        // explain a [redacted: …] trace row instead of leaving it looking broken.
        String rule = Redaction.firstRule(hook.command());
        out.put("redactionRule", rule == null ? "" : rule);
        out.put("timeoutSeconds", hook.timeoutSeconds());
        out.put("effectiveTimeoutSeconds",
                hook.timeoutOrDefault(HookRunner.DEFAULT_TIMEOUT_SECONDS));
        return out;
    }

    /**
     * {@code PUT /api/settings/user}: applies a partial patch to
     * {@code ~/.spectro/settings.json} and answers the fresh process-moment view —
     * the same shape {@link #settings} would return for {@code session=null}. A
     * patch that sets {@code logLevel} takes effect immediately on this running
     * process via {@link dev.spectroscope.cli.LogSetup#apply}, not just on the next boot.
     *
     * @param patch a flat JSON object; a {@code null}-valued entry removes that key
     * @return the fresh {@link #settings} view, process-moment scope
     * @throws ResponseStatusException 400 when the patch fails validation, 500 on
     *                                  an I/O failure writing the file
     */
    @PutMapping("/api/settings/user")
    public Map<String, Object> putUser(@RequestBody JsonNode patch, HttpServletRequest request) {
        requireLocal(request, true);
        applyPatch(SettingsWriter.userSettingsFile(), SettingsWriter.Scope.USER, patch);
        if (patch.hasNonNull("logLevel")) {
            dev.spectroscope.cli.LogSetup.apply(patch.get("logLevel").asText());   // live, not just next boot
        }
        return settings(null, request);
    }

    /**
     * {@code PUT /api/settings/project?session=}: applies a partial patch to the
     * session's workspace {@code .spectro/settings.json} and answers the fresh
     * session-moment view.
     *
     * @param session the session id whose workspace is written; must resolve
     *                (a pinned or configured workspace) or the request is refused
     * @param patch   a flat JSON object; a {@code null}-valued entry removes that key
     * @return the fresh {@link #settings} view for this session
     * @throws ResponseStatusException 400 for a malformed session id or an invalid
     *                                  patch, 404 when the session has no workspace
     */
    @PutMapping("/api/settings/project")
    public Map<String, Object> putProject(@RequestParam("session") String session,
            @RequestBody JsonNode patch, HttpServletRequest request) {
        requireLocal(request, true);
        Path ws = requireWorkspace(session);
        applyPatch(ws.resolve(SpectroConfig.PROJECT_SETTINGS), SettingsWriter.Scope.PROJECT, patch);
        return settings(session, request);
    }

    /**
     * {@code PUT /api/settings/local?session=}: applies a partial patch to the
     * session's workspace {@code .spectro/settings.local.json} (machine-local,
     * gitignored — {@link SettingsWriter#patch} ensures the {@code .gitignore}
     * entry) and answers the fresh session-moment view.
     *
     * @param session the session id whose workspace is written; must resolve
     *                (a pinned or configured workspace) or the request is refused
     * @param patch   a flat JSON object; a {@code null}-valued entry removes that key
     * @return the fresh {@link #settings} view for this session
     * @throws ResponseStatusException 400 for a malformed session id or an invalid
     *                                  patch, 404 when the session has no workspace
     */
    @PutMapping("/api/settings/local")
    public Map<String, Object> putLocal(@RequestParam("session") String session,
            @RequestBody JsonNode patch, HttpServletRequest request) {
        requireLocal(request, true);
        Path ws = requireWorkspace(session);
        applyPatch(ws.resolve(WS_LOCAL_SETTINGS), SettingsWriter.Scope.LOCAL, patch);
        return settings(session, request);
    }

    /**
     * The fence, applied before anything is read or written: 404 for a
     * non-loopback caller or a DNS-rebound Host; writes additionally refuse a
     * cross-site Origin (the key writer's bar). 404 — not 403 — so a refused
     * caller cannot even fingerprint that a spectro answers here.
     *
     * @param request the servlet request
     * @param write   whether the Origin fence joins (the PUTs)
     * @throws ResponseStatusException 404 when the fence refuses
     */
    private static void requireLocal(HttpServletRequest request, boolean write) {
        boolean allowed = LocalOrigin.isLocalOrigin(request)
                && (!write || LocalOrigin.originIsLoopbackOrAbsent(request));
        if (!allowed) {
            throw new ResponseStatusException(HttpStatus.NOT_FOUND);
        }
    }

    /**
     * The concrete settings file paths for this view — user and launch-dir
     * always, the workspace's project/local pair only once a workspace exists.
     *
     * @param workspace the resolved workspace directory, or {@code null} in
     *                  the process-moment view
     * @return the file paths, keyed by scope name
     */
    private Map<String, Object> files(Path workspace) {
        Map<String, Object> files = new LinkedHashMap<>();
        files.put("user", SettingsWriter.userSettingsFile().toString());
        files.put("launchDir", launchDir.resolve(SpectroConfig.PROJECT_SETTINGS).toString());
        if (workspace != null) {
            files.put("project", workspace.resolve(SpectroConfig.PROJECT_SETTINGS).toString());
            files.put("local", workspace.resolve(WS_LOCAL_SETTINGS).toString());
        }
        return files;
    }

    /**
     * Resolves the session's workspace, read-only. A {@code null}/blank
     * session is the process moment ({@code null} back, no workspace scopes
     * join the chain). Otherwise the id's shape is checked first — a malformed
     * id never reaches any lookup or the filesystem — then the folder the run
     * actually resolved wins, and before any run a picked pin wins over the
     * configured/env workspace; none of the three existing answers 404.
     *
     * <p>Consequence worth naming: a session running in an auto folder used to
     * answer 404 here, because nothing was pinned and nothing configured. It
     * now resolves, so a project-scope write lands in that per-session folder.
     * That is more consistent and arguably less useful, since nothing reads it
     * back after the session ends. It is not reachable from the gear, which
     * gates the project sections on the connect-time {@code configured} flag.</p>
     *
     * @param session the session id from the query, or {@code null}/blank
     * @return the resolved workspace directory, or {@code null} for the
     *         process-moment view
     * @throws ResponseStatusException 400 for a malformed id, 404 when nothing resolves
     */
    private Path resolveWorkspace(String session) {
        if (session == null || session.isBlank()) {
            return null;
        }
        if (!SESSION_ID.matcher(session).matches()) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "malformed session id");
        }
        // The folder the run actually resolved wins, because that is the one the
        // agent reads its settings from and the one the Files tree shows. This
        // used to recompute pinned-or-configured from a config read fresh, so a
        // write could land in a directory the running session has never seen.
        String ran = workspaceResolved.apply(session);
        if (ran != null && !ran.isBlank()) {
            return Path.of(ran).toAbsolutePath().normalize();
        }
        String pinned = workspacePin.apply(session);
        String configured = pinned != null ? pinned
                : SpectroConfig.load(SpectroConfig.Overrides.none()).workspace();
        if (configured == null) {
            throw new ResponseStatusException(HttpStatus.NOT_FOUND,
                    "session has no pinned or configured workspace");
        }
        return WorkspaceResolver.locate(configured, session);
    }

    /**
     * Resolves the session's workspace for a write, refusing outright when
     * none exists. {@link #resolveWorkspace} already throws 400/404 for a
     * malformed or unresolvable session id, but it answers plain {@code null}
     * for a blank/absent one (its process-moment case for {@code GET}) — a
     * PUT has no such moment, so a blank {@code session} here is itself a
     * 400, not a silent process-scope write.
     *
     * @param session the session id whose workspace must be written to
     * @return the resolved workspace directory, never {@code null}
     * @throws ResponseStatusException 400/404 as {@link #resolveWorkspace},
     *                                  or 400 when {@code session} is blank
     */
    private Path requireWorkspace(String session) {
        Path ws = resolveWorkspace(session);   // 400/404 as in GET
        if (ws == null) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "session is required");
        }
        return ws;
    }

    /**
     * Applies a patch through {@link SettingsWriter#patch}, translating its
     * checked failure modes into the settings API's HTTP contract: a rejected
     * patch is a client error carrying the exact validation message, an I/O
     * failure is a server error.
     *
     * @param file  the settings file to read-modify-write
     * @param scope which scope {@code file} represents
     * @param patch a flat JSON object; a {@code null}-valued entry removes that key
     * @throws ResponseStatusException 400 with {@link IllegalArgumentException#getMessage()}
     *                                  as the reason, or 500 when the file cannot be written
     */
    private void applyPatch(Path file, SettingsWriter.Scope scope, JsonNode patch) {
        try {
            SettingsWriter.patch(file, scope, patch);
        } catch (IllegalArgumentException invalid) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, invalid.getMessage());
        } catch (IOException io) {
            throw new ResponseStatusException(HttpStatus.INTERNAL_SERVER_ERROR,
                    "could not write settings: " + io.getMessage());
        }
    }
}
