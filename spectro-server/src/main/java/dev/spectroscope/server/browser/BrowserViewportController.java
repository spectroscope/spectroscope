package dev.spectroscope.server.browser;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import dev.spectroscope.core.browser.BrowserFace;
import dev.spectroscope.server.web.LocalOrigin;

import jakarta.servlet.http.HttpServletRequest;

import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

import java.util.LinkedHashMap;
import java.util.Map;

/**
 * Where the browser pane goes, and whether one exists — the two things the web
 * UI needs in order to draw the browser segment honestly.
 *
 * <p><b>Why a REST hop for a rectangle.</b> The pane is a native
 * {@code WebContentsView} laid over the desktop window, so it is positioned in
 * window coordinates while the layout that decides those coordinates is a React
 * component. The obvious wire between them is a preload script and
 * {@code ipcRenderer}, and that is exactly the surface {@code navigationGuard.ts}
 * says this shell deliberately does not have. So the page measures its own
 * placeholder and posts the rectangle here; the server forwards it down the
 * control channel the shell already holds. One extra hop on a resize, and no new
 * capability in the renderer.
 *
 * <p>The GET is what makes the segment honest on the web face: a reader running
 * {@code spectro web} gets {@code attached: false} and a panel that says so,
 * rather than an empty rectangle that looks broken. That is the ratified trade
 * from card 200 stated in the UI instead of only in a document.
 *
 * <p>Both endpoints wear the loopback + Origin fence the rest of the API wears
 * and answer 404 to anyone else.
 *
 * <p><b>Both now name a session (card 218).</b> There is a browser per session,
 * so "where does the pane go" and "what is it showing" are questions ABOUT one
 * session. The id travels as an ordinary parameter and is not a capability: the
 * same caller that could send it can already read that session's whole
 * transcript through {@code /api/sessions/&#123;id&#125;} behind the same fence,
 * so nothing here is reachable that was not reachable before. What the parameter
 * cannot do is open a browser: {@code viewport} only positions a pane that some
 * session's agent already opened, and it answers with a rectangle rather than
 * with a page.
 */
@RestController
public class BrowserViewportController {

    private static final ObjectMapper JSON = new ObjectMapper();

    private final BrowserControlSocket control;

    /**
     * Takes the one control channel, which is also the directory of every
     * session's {@link BrowserFace}.
     *
     * @param control the control channel
     */
    public BrowserViewportController(BrowserControlSocket control) {
        this.control = control;
    }

    /**
     * Whether a browser pane is attached, and what THIS session's one is showing.
     *
     * @param sessionId the session asking — absent before a session mints its id
     * @param request   the servlet request, for the local fence
     * @return the status, or 404 to a non-local caller
     */
    @GetMapping("/api/browser/status")
    public ResponseEntity<Map<String, Object>> status(
            @RequestParam(name = "sessionId", required = false) String sessionId,
            HttpServletRequest request) {
        if (!local(request)) {
            return ResponseEntity.notFound().build();
        }
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("attached", control.attached());
        // A page that has not started a session yet has no browser and no
        // address. Saying null is the honest answer; borrowing another session's
        // address would put a page in the segment's address line that this
        // session's agent is not driving.
        body.put("url", sessionId == null || sessionId.isBlank()
                ? null : control.forSession(sessionId).pageUrl());
        return ResponseEntity.ok(body);
    }

    /**
     * The rectangle the browser segment reserved, in window CSS pixels.
     *
     * @param rect    x, y, width, height and whether the segment is showing
     * @param request the servlet request, for the local fence
     * @return 204 either way — the page must not stall on a shell that is absent
     */
    @PostMapping("/api/browser/viewport")
    public ResponseEntity<Void> viewport(@RequestBody Viewport rect, HttpServletRequest request) {
        if (!local(request)) {
            return ResponseEntity.notFound().build();
        }
        if (!control.attached()) {
            return ResponseEntity.noContent().build();
        }
        ObjectNode args = JSON.createObjectNode();
        args.put("x", rect.x());
        args.put("y", rect.y());
        args.put("width", rect.width());
        args.put("height", rect.height());
        args.put("visible", rect.visible());
        // The session the app is SHOWING. This is what makes the rail segment a
        // view onto the current session's browser rather than a second door onto
        // whichever agent happened to run last.
        String sessionId = rect.sessionId() == null || rect.sessionId().isBlank()
                ? null : rect.sessionId();
        control.viewport(sessionId, args);
        return ResponseEntity.noContent().build();
    }

    /**
     * The browser segment's own rectangle, and whose browser belongs in it.
     *
     * @param x         left edge in window CSS pixels
     * @param y         top edge in window CSS pixels
     * @param width     the reserved width
     * @param height    the reserved height
     * @param visible   whether the segment is the one on screen
     * @param sessionId the session the app is showing, or null before one exists
     */
    public record Viewport(int x, int y, int width, int height, boolean visible,
            String sessionId) {}

    /** The same loopback + Host + Origin fence the rest of the API wears. */
    private static boolean local(HttpServletRequest request) {
        return LocalOrigin.isLocalOrigin(request) && LocalOrigin.originIsLoopbackOrAbsent(request);
    }
}
