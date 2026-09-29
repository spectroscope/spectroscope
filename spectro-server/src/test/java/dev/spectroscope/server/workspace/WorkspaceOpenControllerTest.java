package dev.spectroscope.server.workspace;

import dev.spectroscope.server.session.SessionWorkspaces;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.mock.web.MockHttpServletRequest;
import org.springframework.web.bind.annotation.PostMapping;

import java.io.IOException;
import java.lang.reflect.Method;
import java.lang.reflect.RecordComponent;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;
import java.util.Map;
import java.util.UUID;

import static org.junit.jupiter.api.Assertions.assertArrayEquals;
import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * The folder chip's two server actions (card 462): show the live session's
 * working folder in Finder, and open Terminal there. Proven through the
 * launcher seam, so no test ever starts Finder or Terminal; each test reads the
 * exact argv that would have run.
 */
class WorkspaceOpenControllerTest {

    /** Every argv the controller asked to start, in order. */
    private final List<List<String>> launched = new ArrayList<>();

    private WorkspaceOpenController controller() {
        return new WorkspaceOpenController(launched::add, () -> true);
    }

    /** A legitimate operator request: loopback peer, localhost Host, no Origin. */
    private static MockHttpServletRequest local() {
        return new MockHttpServletRequest();
    }

    /** Records a folder as a fresh session's resolved workspace, as the socket does. */
    private static String sessionWorkingIn(Path folder) {
        String id = "card462-" + UUID.randomUUID();
        SessionWorkspaces.resolved(id, folder.toString());
        return id;
    }

    private static WorkspaceOpenController.OpenRequest body(String sessionId) {
        return new WorkspaceOpenController.OpenRequest(sessionId);
    }

    @Test
    void revealOpensTheSessionsResolvedFolderInFinder(@TempDir Path dir) throws IOException {
        String id = sessionWorkingIn(dir);

        ResponseEntity<?> response = controller().reveal(body(id), local());

        assertEquals(204, response.getStatusCode().value());
        assertEquals(List.of(List.of("/usr/bin/open", dir.toRealPath().toString())), launched);
    }

    @Test
    void terminalOpensTerminalAppInTheSessionsResolvedFolder(@TempDir Path dir) throws IOException {
        String id = sessionWorkingIn(dir);

        ResponseEntity<?> response = controller().terminal(body(id), local());

        assertEquals(204, response.getStatusCode().value());
        assertEquals(List.of(List.of("/usr/bin/open", "-a", "Terminal", dir.toRealPath().toString())),
                launched);
    }

    @Test
    void theFolderHandedOnIsTheRealPathNotTheRecordedSpelling(@TempDir Path dir) throws IOException {
        Path real = Files.createDirectory(dir.resolve("real"));
        Path link = Files.createSymbolicLink(dir.resolve("link"), real);
        String id = sessionWorkingIn(link);

        assertEquals(204, controller().reveal(body(id), local()).getStatusCode().value());
        assertEquals(List.of(List.of("/usr/bin/open", real.toRealPath().toString())), launched);
    }

    @Test
    void anUnknownSessionAnswers404AndLaunchesNothing() {
        String never = "card462-never-" + UUID.randomUUID();

        assertEquals(404, controller().reveal(body(never), local()).getStatusCode().value());
        assertEquals(404, controller().terminal(body(never), local()).getStatusCode().value());
        assertEquals(List.of(), launched);
    }

    @Test
    void aRecordedFolderThatIsGoneAnswers404AndLaunchesNothing(@TempDir Path dir) {
        String id = sessionWorkingIn(dir.resolve("deleted-since"));

        assertEquals(404, controller().reveal(body(id), local()).getStatusCode().value());
        assertEquals(404, controller().terminal(body(id), local()).getStatusCode().value());
        assertEquals(List.of(), launched);
    }

    @Test
    void aRecordedPathThatIsAFileAnswers404AndLaunchesNothing(@TempDir Path dir) throws IOException {
        Path file = Files.writeString(dir.resolve("notes.txt"), "not a folder");
        String id = sessionWorkingIn(file);

        assertEquals(404, controller().reveal(body(id), local()).getStatusCode().value());
        assertEquals(404, controller().terminal(body(id), local()).getStatusCode().value());
        assertEquals(List.of(), launched);
    }

    @Test
    void aReboundHostAnswersTheBlank404AndLaunchesNothing(@TempDir Path dir) {
        String id = sessionWorkingIn(dir);
        MockHttpServletRequest rebound = local();
        rebound.setServerName("attacker.example");

        assertEquals(404, controller().reveal(body(id), rebound).getStatusCode().value());
        assertEquals(404, controller().terminal(body(id), rebound).getStatusCode().value());
        assertEquals(List.of(), launched);
    }

    @Test
    void aRemotePeerAnswersTheBlank404AndLaunchesNothing(@TempDir Path dir) {
        String id = sessionWorkingIn(dir);
        MockHttpServletRequest remote = local();
        remote.setRemoteAddr("203.0.113.1");

        assertEquals(404, controller().reveal(body(id), remote).getStatusCode().value());
        assertEquals(404, controller().terminal(body(id), remote).getStatusCode().value());
        assertEquals(List.of(), launched);
    }

    @Test
    void aCrossSiteOriginAnswersTheBlank404AndLaunchesNothing(@TempDir Path dir) {
        String id = sessionWorkingIn(dir);
        MockHttpServletRequest crossSite = local();
        crossSite.addHeader("Origin", "https://evil.example");

        assertEquals(404, controller().reveal(body(id), crossSite).getStatusCode().value());
        assertEquals(404, controller().terminal(body(id), crossSite).getStatusCode().value());
        assertEquals(List.of(), launched);
    }

    @Test
    void aLocalOriginHeaderIsAccepted(@TempDir Path dir) {
        String id = sessionWorkingIn(dir);
        MockHttpServletRequest page = local();
        page.addHeader("Origin", "http://localhost:8080");

        assertEquals(204, controller().reveal(body(id), page).getStatusCode().value());
        assertEquals(1, launched.size());
    }

    @Test
    void aPlatformOtherThanMacOsAnswers501AndLaunchesNothing(@TempDir Path dir) {
        String id = sessionWorkingIn(dir);
        var elsewhere = new WorkspaceOpenController(launched::add, () -> false);

        ResponseEntity<?> reveal = elsewhere.reveal(body(id), local());
        ResponseEntity<?> terminal = elsewhere.terminal(body(id), local());

        assertEquals(501, reveal.getStatusCode().value());
        assertEquals(501, terminal.getStatusCode().value());
        assertTrue(reveal.getBody() instanceof Map<?, ?> m && m.containsKey("message"),
                "501 names the reason, like the folder picker's 501");
        assertEquals(List.of(), launched);
    }

    @Test
    void aMissingOrMalformedSessionIdAnswers400AndLaunchesNothing() {
        var c = controller();
        assertEquals(400, c.reveal(null, local()).getStatusCode().value());
        assertEquals(400, c.reveal(body(null), local()).getStatusCode().value());
        assertEquals(400, c.reveal(body(""), local()).getStatusCode().value());
        assertEquals(400, c.terminal(body("../etc"), local()).getStatusCode().value());
        assertEquals(400, c.terminal(body("/Users/me"), local()).getStatusCode().value());
        assertEquals(List.of(), launched);
    }

    @Test
    void aLauncherThatCannotStartAnswers500(@TempDir Path dir) {
        String id = sessionWorkingIn(dir);
        var broken = new WorkspaceOpenController(argv -> {
            throw new IOException("no such program");
        }, () -> true);

        assertEquals(500, broken.reveal(body(id), local()).getStatusCode().value());
        assertEquals(500, broken.terminal(body(id), local()).getStatusCode().value());
    }

    @Test
    void theRequestCarriesASessionIdAndNothingElse() {
        String[] components = Arrays.stream(WorkspaceOpenController.OpenRequest.class.getRecordComponents())
                .map(RecordComponent::getName)
                .toArray(String[]::new);

        assertArrayEquals(new String[] {"sessionId"}, components,
                "the client names a session; a path field would let it name any folder");
    }

    @Test
    void bothEndpointsArePostsThatOnlyConsumeJson() throws NoSuchMethodException {
        assertMapping("reveal", "/api/workspace/reveal");
        assertMapping("terminal", "/api/workspace/terminal");
    }

    private static void assertMapping(String method, String path) throws NoSuchMethodException {
        Method handler = WorkspaceOpenController.class.getMethod(method,
                WorkspaceOpenController.OpenRequest.class, jakarta.servlet.http.HttpServletRequest.class);
        PostMapping mapping = handler.getAnnotation(PostMapping.class);
        assertArrayEquals(new String[] {path}, mapping.value());
        assertArrayEquals(new String[] {MediaType.APPLICATION_JSON_VALUE}, mapping.consumes(),
                "consumes=json forces the preflight a foreign page cannot pass");
    }
}
