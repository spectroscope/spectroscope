package dev.spectroscope.server.codegraph;

import dev.spectroscope.core.config.SpectroConfig;
import dev.spectroscope.core.tools.ToolPath;
import dev.spectroscope.server.session.SessionWorkspaces;
import dev.spectroscope.server.session.SessionsController;
import dev.spectroscope.server.web.AppPageTickets;
import dev.spectroscope.server.web.LocalOrigin;
import jakarta.servlet.http.HttpServletRequest;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.temporal.ChronoUnit;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.function.Function;
import java.util.function.Supplier;
import java.util.regex.Pattern;

/**
 * "Build code graph" (card 472): graphify run as a background job of the
 * harness against a session's working folder, and its {@code graph.html}
 * served to the internal browser.
 *
 * <p>The client names a session, never a path. The folder is the one the
 * socket recorded in {@link SessionWorkspaces} when it resolved the workspace,
 * or, for a stored session not continued yet, the folder its own record names
 * (card 284), realised on disk; it is the only folder graphify is ever pointed
 * at. The
 * provider is checked against the harness's own provider list and the model
 * against that provider's own model list ({@link GraphifyBackends}) before
 * either becomes an argument, and the steps are
 * argument lists ({@link GraphifyCommand}), never shell strings.</p>
 *
 * <p>Fence: {@link LocalOrigin#isLocalOrigin} on every endpoint, plus the
 * Origin check and {@code consumes=json} on the one that starts a program;
 * every refusal is the module's blank 404.</p>
 */
@RestController
public class CodeGraphController {

    /** Same session-id shape guard as the files, image and folder-chip endpoints. */
    private static final Pattern SESSION_ID = Pattern.compile("[A-Za-z0-9][A-Za-z0-9-]*");

    /** The graph page graphify writes into a folder it built. */
    static final Path GRAPH_HTML = Path.of("graphify-out", "graph.html");

    /** The largest graph page served; graphify aggregates past 5000 nodes, so real pages stay far below. */
    static final long MAX_PAGE_BYTES = 64L * 1024 * 1024;

    /**
     * The policy the graph page is served under. A {@code graph.html} can come
     * from a cloned repository, and this server's origin is the one every API
     * call trusts. The sandbox gives the page an opaque origin: its scripts run
     * (the graph needs them) but its requests carry {@code Origin: null}, which
     * the API's fences refuse, and it can read nothing the app stores.
     */
    static final String SANDBOX = "sandbox allow-scripts allow-popups";

    /**
     * The start request.
     *
     * @param sessionId the session whose working folder to build
     * @param mode      {@code full} or {@code update}
     * @param provider  a harness provider for community names, or null or blank for none
     * @param model     the model for community names, required with a provider
     */
    public record StartRequest(String sessionId, String mode, String provider, String model) {
    }

    /**
     * Whether the folder has a graph page.
     *
     * @param exists     whether {@code graphify-out/graph.html} is a file inside the folder
     * @param modifiedAt its modification time, ISO-8601 to the second, or null
     */
    public record Graph(boolean exists, String modifiedAt) {
    }

    /**
     * Everything the sheet, the header line and the doctor row read.
     *
     * @param installed whether graphify is on the tool PATH
     * @param binary    where it was found, or null
     * @param searched  the folders the lookup searched
     * @param install   the install line
     * @param folder    the session's resolved folder, or null without a session
     * @param graph     the folder's graph page, or null without a session
     * @param job       the folder's last build since the server started, or null
     * @param backends  the providers the sheet offers for community names
     */
    public record Status(boolean installed, String binary, List<String> searched, String install,
                         String folder, Graph graph, CodeGraphJobs.Snapshot job,
                         List<GraphifyBackends.Choice> backends) {
    }

    private final CodeGraphJobs jobs;
    private final Supplier<ToolPath.Lookup> graphify;
    private final Supplier<Function<String, String>> endpoints;
    private final Function<String, String> keys;
    private final Function<String, List<String>> models;
    private final AppPageTickets tickets;
    private final Function<String, String> recorded;

    /**
     * Production wiring: the shared builds, the tool PATH lookup, the saved
     * config and keys, the model lists the header picker reads, the chip's
     * tickets, and the folder a stored session's record names.
     *
     * @param sessions the controller behind {@code GET /api/models}
     */
    @Autowired
    public CodeGraphController(SessionsController sessions) {
        this(CodeGraphJobs.shared(), () -> ToolPath.locate("graphify"), () -> {
            SpectroConfig config = SpectroConfig.load(SpectroConfig.Overrides.none());
            return config::endpointFor;
        }, SpectroConfig::resolveApiKey, sessions::models, AppPageTickets.shared(),
                dev.spectroscope.core.session.SessionStore::recordedWorkspace);
    }

    /**
     * Seam for tests.
     *
     * @param jobs      the builds
     * @param graphify  where graphify is, looked up per request
     * @param endpoints the address per provider, read per request
     * @param keys      a saved key per environment variable name
     * @param models    the models a provider lists
     * @param tickets   the chip's one-shot tickets, spent by {@link #view}
     * @param recorded  the folder a stored session's record names, by session id
     */
    CodeGraphController(CodeGraphJobs jobs, Supplier<ToolPath.Lookup> graphify,
                        Supplier<Function<String, String>> endpoints, Function<String, String> keys,
                        Function<String, List<String>> models, AppPageTickets tickets,
                        Function<String, String> recorded) {
        this.jobs = jobs;
        this.graphify = graphify;
        this.endpoints = endpoints;
        this.keys = keys;
        this.models = models;
        this.tickets = tickets;
        this.recorded = recorded;
    }

    /**
     * {@code GET /api/codegraph/status}: whether graphify is installed and, for
     * a session, whether its folder has a graph and a build.
     *
     * @param sessionId the session, or absent for the installation alone (doctor)
     * @param request   the servlet request, for the local-origin fence
     * @return 200 with the status; 400 malformed session id; 404 fenced out or
     *         unknown session
     */
    @GetMapping("/api/codegraph/status")
    public ResponseEntity<?> status(@RequestParam(name = "sessionId", required = false) String sessionId,
                                    HttpServletRequest request) {
        if (!LocalOrigin.isLocalOrigin(request)) {
            return ResponseEntity.notFound().build();
        }
        ToolPath.Lookup found = graphify.get();
        List<GraphifyBackends.Choice> offered = GraphifyBackends.offered(keys);
        if (sessionId == null || sessionId.isBlank()) {
            return ResponseEntity.ok(new Status(found.isFound(), found.found(), found.searched(),
                    GraphifyCommand.INSTALL_LINE, null, null, null, offered));
        }
        if (!SESSION_ID.matcher(sessionId).matches()) {
            return ResponseEntity.badRequest().body(Map.of("message", "Malformed session id."));
        }
        Path folder = folderOf(sessionId);
        if (folder == null) {
            return ResponseEntity.notFound().build();
        }
        Path page = graphPage(folder);
        Graph graph = new Graph(page != null, page == null ? null : modified(page));
        return ResponseEntity.ok(new Status(found.isFound(), found.found(), found.searched(),
                GraphifyCommand.INSTALL_LINE, folder.toString(), graph, jobs.get(folder), offered));
    }

    /**
     * {@code POST /api/codegraph/start}: starts graphify in the background
     * against the session's resolved folder.
     *
     * @param body    the session, the mode and the naming choice
     * @param request the servlet request, for the local-origin fence
     * @return 202 with the running build; 400 malformed request, a provider
     *         outside the list, a model that is not one argument or one the
     *         provider does not list; 404 fenced
     *         out or unknown session; 409 a build already runs for the folder;
     *         503 graphify is not installed, with the install line
     */
    @PostMapping(value = "/api/codegraph/start", consumes = MediaType.APPLICATION_JSON_VALUE)
    public ResponseEntity<?> start(@RequestBody(required = false) StartRequest body,
                                   HttpServletRequest request) {
        if (!LocalOrigin.isLocalOrigin(request) || !LocalOrigin.originIsLoopbackOrAbsent(request)) {
            return ResponseEntity.notFound().build();
        }
        if (body == null || body.sessionId() == null || !SESSION_ID.matcher(body.sessionId()).matches()) {
            return ResponseEntity.badRequest().body(Map.of("message", "Malformed session id."));
        }
        GraphifyCommand.Mode mode;
        try {
            mode = GraphifyCommand.Mode.parse(body.mode());
        } catch (IllegalArgumentException bad) {
            return ResponseEntity.badRequest().body(Map.of("message", bad.getMessage()));
        }
        Path folder = folderOf(body.sessionId());
        if (folder == null) {
            return ResponseEntity.notFound().build();
        }
        ToolPath.Lookup found = graphify.get();
        if (!found.isFound()) {
            Map<String, Object> missing = new LinkedHashMap<>();
            missing.put("message", "graphify is not installed. Install it with: " + GraphifyCommand.INSTALL_LINE);
            missing.put("install", GraphifyCommand.INSTALL_LINE);
            missing.put("searched", found.searched());
            return ResponseEntity.status(503).body(missing);
        }
        GraphifyCommand.Naming naming = null;
        Map<String, String> env = Map.of();
        if (body.provider() != null && !body.provider().isBlank()) {
            try {
                GraphifyBackends.Resolved resolved =
                        GraphifyBackends.resolve(body.provider(), body.model(), endpoints.get(), keys, models);
                naming = resolved.naming();
                env = resolved.env();
            } catch (IllegalArgumentException refused) {
                return ResponseEntity.badRequest().body(Map.of("message", refused.getMessage()));
            }
        }
        List<List<String>> steps = GraphifyCommand.steps(found.found(), folder, mode, naming);
        CodeGraphJobs.Snapshot started = jobs.start(folder, body.sessionId(),
                mode == GraphifyCommand.Mode.FULL ? "full" : "update", steps, env);
        if (started == null) {
            Map<String, Object> busy = new LinkedHashMap<>();
            busy.put("message", "A code graph build is already running for this folder.");
            busy.put("job", jobs.get(folder));
            return ResponseEntity.status(409).body(busy);
        }
        return ResponseEntity.status(202).body(started);
    }

    /**
     * {@code GET /api/codegraph/view}: the session folder's {@code graph.html},
     * for the internal browser, under {@link #SANDBOX}. Served once per ticket:
     * the "Graph ready" chip mints one ({@link AppPageTickets}), and this
     * endpoint spends it, so a load without the press's ticket gets nothing.
     *
     * @param sessionId the session whose folder's graph to show
     * @param ticket    the ticket the chip press minted for this session
     * @param request   the servlet request, for the local-origin fence
     * @return 200 with the page; 404 fenced out, no live ticket for this
     *         session, unknown session, no graph, a page that resolves outside
     *         the folder, or one too large to serve
     */
    @GetMapping("/api/codegraph/view")
    public ResponseEntity<byte[]> view(@RequestParam(name = "sessionId", required = false) String sessionId,
                                       @RequestParam(name = "ticket", required = false) String ticket,
                                       HttpServletRequest request) {
        if (!LocalOrigin.isLocalOrigin(request) || sessionId == null
                || !SESSION_ID.matcher(sessionId).matches() || !tickets.redeem(ticket, sessionId)) {
            return ResponseEntity.notFound().build();
        }
        Path folder = folderOf(sessionId);
        Path page = folder == null ? null : graphPage(folder);
        if (page == null) {
            return ResponseEntity.notFound().build();
        }
        try {
            if (Files.size(page) > MAX_PAGE_BYTES) {
                return ResponseEntity.notFound().build();
            }
            return ResponseEntity.ok()
                    .contentType(new MediaType("text", "html", StandardCharsets.UTF_8))
                    .header("Content-Security-Policy", SANDBOX)
                    .header("X-Content-Type-Options", "nosniff")
                    .header("Cache-Control", "no-store")
                    .body(Files.readAllBytes(page));
        } catch (IOException unreadable) {
            return ResponseEntity.notFound().build();
        }
    }

    /**
     * The session's folder, realised, or null when there is no such directory.
     * A live session's resolved workspace comes first; a stored session opened
     * read-only has resolved none in this process, and its own record names
     * the folder its runs worked in (card 284). A recorded folder that is gone
     * stays gone: {@link Path#toRealPath} creates nothing.
     */
    private Path folderOf(String sessionId) {
        String resolved = SessionWorkspaces.resolvedPath(sessionId);
        if (resolved == null) {
            resolved = recorded.apply(sessionId);
        }
        if (resolved == null || resolved.isBlank()) {
            return null;
        }
        try {
            Path real = Path.of(resolved).toRealPath();
            return Files.isDirectory(real) ? real : null;
        } catch (IOException | RuntimeException gone) {
            return null;
        }
    }

    /** The folder's graph page, realised, or null when it is absent or resolves outside the folder. */
    private static Path graphPage(Path folder) {
        try {
            Path real = folder.resolve(GRAPH_HTML).toRealPath();
            return real.startsWith(folder) && Files.isRegularFile(real) ? real : null;
        } catch (IOException | RuntimeException absent) {
            return null;
        }
    }

    /** A file's modification time to the second, or null when it cannot be read. */
    private static String modified(Path file) {
        try {
            return Files.getLastModifiedTime(file).toInstant().truncatedTo(ChronoUnit.SECONDS).toString();
        } catch (IOException unreadable) {
            return null;
        }
    }
}
