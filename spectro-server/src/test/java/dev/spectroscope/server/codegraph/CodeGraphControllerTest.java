package dev.spectroscope.server.codegraph;

import dev.spectroscope.core.tools.ToolPath;
import dev.spectroscope.server.session.SessionWorkspaces;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.Timeout;
import org.junit.jupiter.api.io.TempDir;
import org.springframework.http.ResponseEntity;
import org.springframework.mock.web.MockHttpServletRequest;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.attribute.FileTime;
import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.time.ZoneOffset;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.function.Function;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * Card 472: the three endpoints behind the build sheet and the ready chip.
 * Status says whether graphify is installed and whether the session's folder
 * has a graph; start launches a job against the resolved workspace and nothing
 * else; view serves that folder's graph.html in a sandbox.
 */
@Timeout(value = 20, threadMode = Timeout.ThreadMode.SEPARATE_THREAD)
class CodeGraphControllerTest {

    private static final Clock CLOCK = Clock.fixed(Instant.parse("2026-10-09T10:00:00Z"), ZoneOffset.UTC);
    private static final List<String> SEARCHED = List.of("/opt/homebrew/bin", "/usr/bin");
    private static final ToolPath.Lookup FOUND = new ToolPath.Lookup("graphify", "/opt/tools/graphify", SEARCHED);
    private static final ToolPath.Lookup MISSING = new ToolPath.Lookup("graphify", null, SEARCHED);

    private static final Function<String, String> ENDPOINTS = provider -> switch (provider) {
        case "ollama" -> "http://localhost:11434";
        default -> "http://localhost:1234";
    };

    private final CodeGraphJobsTest.Script script = new CodeGraphJobsTest.Script();
    private final CodeGraphJobs jobs = new CodeGraphJobs(script, CLOCK, Duration.ofMinutes(5));

    /** What /api/models answers per provider: ollama has one model installed, the rest list nothing. */
    private static final Function<String, List<String>> MODELS =
            provider -> "ollama".equals(provider) ? List.of("qwen3:8b") : List.of();

    private final dev.spectroscope.server.web.AppPageTickets tickets =
            new dev.spectroscope.server.web.AppPageTickets(System::currentTimeMillis);

    /** What the stored sessions record as their folder (card 284), by session id. */
    private final Map<String, String> recorded = new java.util.concurrent.ConcurrentHashMap<>();

    private CodeGraphController controller(ToolPath.Lookup graphify) {
        return new CodeGraphController(jobs, () -> graphify, () -> ENDPOINTS, Map.<String, String>of()::get,
                MODELS, tickets, recorded::get);
    }

    private static MockHttpServletRequest local() {
        return new MockHttpServletRequest();
    }

    private static String sessionWorkingIn(Path folder) {
        String id = "card472-" + UUID.randomUUID();
        SessionWorkspaces.resolved(id, folder.toString());
        return id;
    }

    private static CodeGraphController.StartRequest start(String sessionId, String mode, String provider,
                                                          String model) {
        return new CodeGraphController.StartRequest(sessionId, mode, provider, model);
    }

    @Test
    void statusWithoutGraphifySaysSoAndNamesTheInstallLine() {
        ResponseEntity<?> response = controller(MISSING).status(null, local());

        assertEquals(200, response.getStatusCode().value());
        CodeGraphController.Status status = (CodeGraphController.Status) response.getBody();
        assertNotNull(status);
        assertFalse(status.installed());
        assertEquals("uv tool install graphifyy", status.install());
        assertEquals(SEARCHED, status.searched());
    }

    @Test
    void statusForASessionNamesItsResolvedFolderAndAnExistingGraphWithTheFilesTime(@TempDir Path dir)
            throws IOException {
        Path html = Files.createDirectories(dir.resolve("graphify-out")).resolve("graph.html");
        Files.writeString(html, "<html></html>");
        Files.setLastModifiedTime(html, FileTime.from(Instant.parse("2026-10-08T07:30:00Z")));
        String id = sessionWorkingIn(dir);

        CodeGraphController.Status status =
                (CodeGraphController.Status) controller(FOUND).status(id, local()).getBody();

        assertNotNull(status);
        assertTrue(status.installed());
        assertEquals(dir.toRealPath().toString(), status.folder());
        assertTrue(status.graph().exists());
        assertEquals("2026-10-08T07:30:00Z", status.graph().modifiedAt());
        assertNull(status.job());
    }

    @Test
    void statusForAFolderWithoutAGraphSaysThereIsNone(@TempDir Path dir) {
        String id = sessionWorkingIn(dir);

        CodeGraphController.Status status =
                (CodeGraphController.Status) controller(FOUND).status(id, local()).getBody();

        assertNotNull(status);
        assertFalse(status.graph().exists());
        assertNull(status.graph().modifiedAt());
    }

    @Test
    void anUnknownSessionAnswers404() {
        assertEquals(404, controller(FOUND).status("card472-never-" + UUID.randomUUID(), local())
                .getStatusCode().value());
    }

    @Test
    void startRunsGraphifyAgainstTheResolvedWorkspaceOnly(@TempDir Path dir) throws Exception {
        Path real = Files.createDirectory(dir.resolve("real"));
        Path link = Files.createSymbolicLink(dir.resolve("link"), real);
        String id = sessionWorkingIn(link);
        CodeGraphJobsTest.FakeProcess p = script.next();

        ResponseEntity<?> response = controller(FOUND).start(start(id, "update", null, null), local());

        assertEquals(202, response.getStatusCode().value());
        p.exit(0);
        long until = System.nanoTime() + 5_000_000_000L;
        while (script.argvs.isEmpty() && System.nanoTime() < until) {
            Thread.sleep(5);
        }
        assertEquals(List.of(List.of("/opt/tools/graphify", "update", real.toRealPath().toString())),
                script.argvs);
        assertEquals(List.of(real.toRealPath()), script.folders);
    }

    @Test
    void startWithABackendPassesTheMappedBackendAndModelAsSingleArguments(@TempDir Path dir)
            throws Exception {
        String id = sessionWorkingIn(dir);
        CodeGraphJobsTest.FakeProcess extract = script.next();
        CodeGraphJobsTest.FakeProcess cluster = script.next();
        CodeGraphJobsTest.FakeProcess label = script.next();

        ResponseEntity<?> response = controller(FOUND).start(start(id, "full", "ollama", "qwen3:8b"), local());

        assertEquals(202, response.getStatusCode().value());
        extract.exit(0);
        long until = System.nanoTime() + 5_000_000_000L;
        while (script.argvs.size() < 2 && System.nanoTime() < until) {
            Thread.sleep(5);
        }
        cluster.exit(0);
        while (script.argvs.size() < 3 && System.nanoTime() < until) {
            Thread.sleep(5);
        }
        label.exit(0);
        String folder = dir.toRealPath().toString();
        assertEquals(List.of(
                List.of("/opt/tools/graphify", "extract", folder, "--code-only"),
                List.of("/opt/tools/graphify", "cluster-only", folder, "--no-label"),
                List.of("/opt/tools/graphify", "label", folder, "--missing-only",
                        "--backend=ollama", "--model=qwen3:8b")),
                script.argvs);
        assertEquals("http://localhost:11434/v1", script.envs.get(2).get("OLLAMA_BASE_URL"));
    }

    @Test
    void startWithoutGraphifyAnswers503WithTheInstallLineAndStartsNothing(@TempDir Path dir) {
        String id = sessionWorkingIn(dir);

        ResponseEntity<?> response = controller(MISSING).start(start(id, "full", null, null), local());

        assertEquals(503, response.getStatusCode().value());
        assertTrue(String.valueOf(response.getBody()).contains("uv tool install graphifyy"),
                String.valueOf(response.getBody()));
        assertTrue(script.argvs.isEmpty());
    }

    @Test
    void startWithAProviderOutsideTheListOrABadModelAnswers400AndStartsNothing(@TempDir Path dir) {
        String id = sessionWorkingIn(dir);
        CodeGraphController c = controller(FOUND);

        assertEquals(400, c.start(start(id, "full", "bedrock", "m"), local()).getStatusCode().value());
        assertEquals(400, c.start(start(id, "full", "ollama", "--force"), local()).getStatusCode().value());
        assertEquals(400, c.start(start(id, "full", "ollama", null), local()).getStatusCode().value());
        assertEquals(400, c.start(start(id, "full", "lmstudio", "some-model"), local()).getStatusCode().value());
        assertEquals(400, c.start(start(id, "rebuild", null, null), local()).getStatusCode().value());
        assertEquals(400, c.start(start("../etc", "full", null, null), local()).getStatusCode().value());
        assertTrue(script.argvs.isEmpty());
    }

    @Test
    void startWithAModelTheProviderDoesNotListAnswers400WithTheReasonAndStartsNothing(@TempDir Path dir) {
        String id = sessionWorkingIn(dir);

        ResponseEntity<?> response = controller(FOUND).start(start(id, "full", "ollama", "llama3"), local());

        assertEquals(400, response.getStatusCode().value());
        assertEquals(Map.of("message", "not a model ollama lists"), response.getBody());
        assertTrue(script.argvs.isEmpty());
    }

    @Test
    void aSecondStartWhileOneRunsAnswers409(@TempDir Path dir) throws Exception {
        String id = sessionWorkingIn(dir);
        CodeGraphJobsTest.FakeProcess p = script.next();
        CodeGraphController c = controller(FOUND);

        assertEquals(202, c.start(start(id, "update", null, null), local()).getStatusCode().value());
        assertEquals(409, c.start(start(id, "update", null, null), local()).getStatusCode().value());
        p.exit(0);
    }

    @Test
    void startFromAForeignOriginAnswersTheBlank404(@TempDir Path dir) {
        String id = sessionWorkingIn(dir);
        MockHttpServletRequest foreign = local();
        foreign.addHeader("Origin", "https://evil.example");

        assertEquals(404, controller(FOUND).start(start(id, "full", null, null), foreign)
                .getStatusCode().value());
        assertTrue(script.argvs.isEmpty());
    }

    @Test
    void viewServesTheFoldersGraphInASandboxSoItCannotActAsTheApp(@TempDir Path dir) throws IOException {
        Path html = Files.createDirectories(dir.resolve("graphify-out")).resolve("graph.html");
        Files.writeString(html, "<html><body>the graph</body></html>");
        String id = sessionWorkingIn(dir);

        ResponseEntity<byte[]> response = controller(FOUND).view(id, tickets.mint(id), local());

        assertEquals(200, response.getStatusCode().value());
        assertEquals("<html><body>the graph</body></html>",
                new String(response.getBody(), StandardCharsets.UTF_8));
        assertEquals("text/html;charset=UTF-8", String.valueOf(response.getHeaders().getContentType()));
        String csp = response.getHeaders().getFirst("Content-Security-Policy");
        assertNotNull(csp, "a graph.html from a cloned repository would run on the app's own origin");
        assertTrue(csp.startsWith("sandbox allow-scripts"), csp);
        assertFalse(csp.contains("allow-same-origin"), csp);
    }

    @Test
    void viewRefusesAGraphHtmlThatLinksOutOfTheFolder(@TempDir Path dir) throws IOException {
        Path outside = Files.writeString(dir.resolve("secret.html"), "not the graph");
        Path project = Files.createDirectory(dir.resolve("project"));
        Files.createSymbolicLink(Files.createDirectory(project.resolve("graphify-out")).resolve("graph.html"),
                outside);
        String id = sessionWorkingIn(project);

        assertEquals(404, controller(FOUND).view(id, tickets.mint(id), local()).getStatusCode().value());
    }

    @Test
    void viewWithoutAGraphAnswers404(@TempDir Path dir) {
        String id = sessionWorkingIn(dir);

        assertEquals(404, controller(FOUND).view(id, tickets.mint(id), local()).getStatusCode().value());
    }

    @Test
    void viewServesOnlyALoadThatCarriesTheTicketTheChipPressMinted(@TempDir Path dir) throws IOException {
        // Card 472: the browser fence lets the view through only with a live
        // ticket, and the view itself checks and spends it, so a page the
        // agent reaches (a curl, an eval, a reload of a spent address) is the
        // blank 404 even when the fence on the other side were open.
        Files.writeString(Files.createDirectories(dir.resolve("graphify-out")).resolve("graph.html"), "g");
        String id = sessionWorkingIn(dir);
        String other = sessionWorkingIn(dir);
        CodeGraphController c = controller(FOUND);

        assertEquals(404, c.view(id, null, local()).getStatusCode().value(), "no ticket");
        assertEquals(404, c.view(id, "0123456789abcdef0123456789abcdef", local()).getStatusCode().value(),
                "a ticket nobody minted");
        String ticket = tickets.mint(id);
        assertEquals(404, c.view(other, ticket, local()).getStatusCode().value(), "another session's ticket");
        assertFalse(tickets.isLive(ticket), "and that try spent it");

        String fresh = tickets.mint(id);
        assertEquals(200, c.view(id, fresh, local()).getStatusCode().value(), "the chip press is served");
        assertEquals(404, c.view(id, fresh, local()).getStatusCode().value(), "once");
    }

    @Test
    void aStoredSessionOpenedReadOnlyShowsTheGraphItsRecordedFolderHas(@TempDir Path dir) throws IOException {
        // AC5: a session opened from the list, not yet continued, has resolved
        // no workspace in this process. Its own record names the folder its
        // runs worked in (card 284), and that folder's graph shows at once.
        Path html = Files.createDirectories(dir.resolve("graphify-out")).resolve("graph.html");
        Files.writeString(html, "<html>stored</html>");
        Files.setLastModifiedTime(html, FileTime.from(Instant.parse("2026-10-08T07:30:00Z")));
        String id = "card472-stored-" + UUID.randomUUID();
        recorded.put(id, dir.toString());
        CodeGraphController c = controller(FOUND);

        CodeGraphController.Status status = (CodeGraphController.Status) c.status(id, local()).getBody();
        assertNotNull(status);
        assertEquals(dir.toRealPath().toString(), status.folder());
        assertTrue(status.graph().exists());
        assertEquals("2026-10-08T07:30:00Z", status.graph().modifiedAt());
        assertEquals(200, c.view(id, tickets.mint(id), local()).getStatusCode().value());
    }

    @Test
    void aLiveResolutionWinsOverTheRecordAndAVanishedRecordedFolderIsNeverCreated(@TempDir Path dir)
            throws IOException {
        Path live = Files.createDirectory(dir.resolve("live"));
        String id = sessionWorkingIn(live);
        recorded.put(id, dir.resolve("old").toString());
        CodeGraphController.Status status =
                (CodeGraphController.Status) controller(FOUND).status(id, local()).getBody();
        assertNotNull(status);
        assertEquals(live.toRealPath().toString(), status.folder());

        String stored = "card472-gone-" + UUID.randomUUID();
        Path gone = dir.resolve("gone");
        recorded.put(stored, gone.toString());
        assertEquals(404, controller(FOUND).status(stored, local()).getStatusCode().value());
        assertFalse(Files.exists(gone), "a folder the record names but the disk lacks is not made");
    }
}
