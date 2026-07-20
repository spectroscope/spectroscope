package dev.spectroscope.server;

import com.fasterxml.jackson.databind.JsonNode;
import dev.spectroscope.core.config.SpectroConfig;
import dev.spectroscope.core.config.SettingsWriter;
import dev.spectroscope.core.config.WorkspaceResolver;
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
 */
@RestController
public class SettingsController {

    /** Session ids as the store mints them, plus the general test/CLI-friendly
     *  shape — never a path, never a dot (same rule as {@code SessionsController}
     *  and {@code WorkspaceController}). */
    private static final Pattern SESSION_ID = Pattern.compile("[A-Za-z0-9][A-Za-z0-9-]*");

    /** Workspace-local settings file, relative to the workspace root. Named
     *  again here rather than reused from {@code SpectroConfig} — its own copy of
     *  this literal is package-private to {@code dev.spectroscope.core.config}, and the
     *  settings API's "files" view needs it purely for display, never to load
     *  or write it directly. */
    private static final String WS_LOCAL_SETTINGS = ".spectro/settings.local.json";

    private final Path launchDir;

    /** session id -> pinned workspace path, or {@code null} when unpinned;
     *  production wiring reads the shared, real {@link SessionWorkspaces} pin
     *  map, tests inject a fake so no real pin state is needed. */
    private final Function<String, String> workspacePin;

    /** Spring wiring: the launch dir is the server process's working directory;
     *  session pins read the shared {@link SessionWorkspaces} map. */
    public SettingsController() {
        this(Path.of(System.getProperty("user.dir")), SessionWorkspaces::pinned);
    }

    /**
     * Seam for tests: both the launch-dir layer's root and the pin lookup are
     * injectable, so a test needs no real {@code SessionWorkspaces} state and
     * no real working directory.
     *
     * @param launchDir    the directory whose {@code .spectro/settings.json} forms
     *                     the launch-dir layer
     * @param workspacePin supplies a session's pinned workspace path, or {@code null}
     */
    SettingsController(Path launchDir, Function<String, String> workspacePin) {
        this.launchDir = launchDir;
        this.workspacePin = workspacePin;
    }

    /**
     * {@code GET /api/settings[?session=]}: the effective configuration
     * alongside its provenance, the raw non-empty layers and the concrete
     * settings file paths — Task 13's web client consumes this shape verbatim.
     *
     * @param session optional session id; absent/blank answers the process-moment
     *                view, present answers that session's workspace-joined view
     * @return {@code effective} (the resolved config, all 17 fields, nulls
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
    public Map<String, Object> settings(@RequestParam(value = "session", required = false) String session) {
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
    public Map<String, Object> putUser(@RequestBody JsonNode patch) {
        applyPatch(SettingsWriter.userSettingsFile(), SettingsWriter.Scope.USER, patch);
        if (patch.hasNonNull("logLevel")) {
            dev.spectroscope.cli.LogSetup.apply(patch.get("logLevel").asText());   // live, not just next boot
        }
        return settings(null);
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
            @RequestBody JsonNode patch) {
        Path ws = requireWorkspace(session);
        applyPatch(ws.resolve(SpectroConfig.PROJECT_SETTINGS), SettingsWriter.Scope.PROJECT, patch);
        return settings(session);
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
            @RequestBody JsonNode patch) {
        Path ws = requireWorkspace(session);
        applyPatch(ws.resolve(WS_LOCAL_SETTINGS), SettingsWriter.Scope.LOCAL, patch);
        return settings(session);
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
     * id never reaches the pin lookup or the filesystem — then a picked pin
     * wins over the configured/env workspace; neither existing answers 404.
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
