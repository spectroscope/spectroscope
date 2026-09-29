package dev.spectroscope.server.workspace;

import dev.spectroscope.server.session.SessionWorkspaces;
import dev.spectroscope.server.transcripts.FolderOpener;
import dev.spectroscope.server.web.LocalOrigin;
import jakarta.servlet.http.HttpServletRequest;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RestController;

import java.nio.file.Path;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.function.BooleanSupplier;
import java.util.regex.Pattern;

/**
 * The folder chip's two server actions (card 462): show a live session's
 * working folder in Finder, and open Terminal in it.
 *
 * <p>The client names a session, never a path. The folder is the one the
 * socket recorded in {@link SessionWorkspaces} when it resolved the workspace,
 * the same value the {@code workspace_info} frame carries. The path is handed
 * to {@link FolderOpener}, which realises it, requires a directory and starts
 * the program from an argument list.</p>
 *
 * <p>Fence: {@link LocalOrigin#isLocalOrigin} plus the Origin check, and
 * {@code consumes=json}; every refusal is the module's blank 404.</p>
 */
@RestController
public class WorkspaceOpenController {

    /** Finder shows a folder it is given. */
    static final List<String> REVEAL = List.of("/usr/bin/open");

    /** Terminal.app opens a window in the folder it is given. */
    static final List<String> TERMINAL = List.of("/usr/bin/open", "-a", "Terminal");

    /** Same session-id shape guard as the files and image endpoints. */
    private static final Pattern SESSION_ID = Pattern.compile("[A-Za-z0-9][A-Za-z0-9-]*");

    private final FolderOpener.Launcher launcher;
    private final BooleanSupplier macOs;

    /**
     * The request body: which live session's folder to open.
     *
     * @param sessionId the session id from the {@code workspace_info} frame
     */
    public record OpenRequest(String sessionId) {}

    /** Production wiring: real processes, macOS detected from {@code os.name}. */
    public WorkspaceOpenController() {
        this(FolderOpener.PROCESS,
                () -> System.getProperty("os.name", "").toLowerCase(Locale.ROOT).contains("mac"));
    }

    /**
     * Seam for tests.
     *
     * @param launcher starts the program
     * @param macOs whether this machine is a Mac
     */
    WorkspaceOpenController(FolderOpener.Launcher launcher, BooleanSupplier macOs) {
        this.launcher = launcher;
        this.macOs = macOs;
    }

    /**
     * {@code POST /api/workspace/reveal}: shows the session's working folder in Finder.
     *
     * @param body the session to look up
     * @param request the servlet request, for the local-origin fence
     * @return 204 opened; 400 missing or malformed session id; 404 fenced out,
     *         unknown session, or no directory there; 501 not macOS; 500 the
     *         program could not be started
     */
    @PostMapping(value = "/api/workspace/reveal", consumes = MediaType.APPLICATION_JSON_VALUE)
    public ResponseEntity<?> reveal(@RequestBody(required = false) OpenRequest body,
                                    HttpServletRequest request) {
        return open(body, request, REVEAL);
    }

    /**
     * {@code POST /api/workspace/terminal}: opens Terminal in the session's working folder.
     *
     * @param body the session to look up
     * @param request the servlet request, for the local-origin fence
     * @return the same answers as {@link #reveal}
     */
    @PostMapping(value = "/api/workspace/terminal", consumes = MediaType.APPLICATION_JSON_VALUE)
    public ResponseEntity<?> terminal(@RequestBody(required = false) OpenRequest body,
                                      HttpServletRequest request) {
        return open(body, request, TERMINAL);
    }

    private ResponseEntity<?> open(OpenRequest body, HttpServletRequest request, List<String> program) {
        if (!LocalOrigin.isLocalOrigin(request) || !LocalOrigin.originIsLoopbackOrAbsent(request)) {
            return ResponseEntity.notFound().build();
        }
        String sessionId = body == null ? null : body.sessionId();
        if (sessionId == null || !SESSION_ID.matcher(sessionId).matches()) {
            return ResponseEntity.badRequest().body(Map.of("message", "Malformed session id."));
        }
        if (!macOs.getAsBoolean()) {
            return ResponseEntity.status(501)
                    .body(Map.of("message", "Opening Finder or Terminal needs macOS."));
        }
        String resolved = SessionWorkspaces.resolvedPath(sessionId);
        if (resolved == null) {
            return ResponseEntity.notFound().build();
        }
        return switch (FolderOpener.open(Path.of(resolved), program, launcher)) {
            case OPENED -> ResponseEntity.noContent().build();
            case MISSING -> ResponseEntity.notFound().build();
            case UNSUPPORTED -> ResponseEntity.status(500)
                    .body(Map.of("message", "The program could not be started."));
        };
    }
}
