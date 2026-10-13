package dev.spectroscope.server.workspace;

import dev.spectroscope.core.events.RunEvent;
import dev.spectroscope.core.session.SessionStore;
import dev.spectroscope.server.session.SessionWorkspaces;

import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import org.springframework.mock.web.MockHttpServletResponse;
import org.springframework.test.web.servlet.MvcResult;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.setup.MockMvcBuilders;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;

import static org.assertj.core.api.Assertions.assertThat;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;

/**
 * Card 586: {@code GET /api/run-document} opens a document a run recorded as
 * written, also under a dot folder such as {@code .superpowers/}, for the run
 * view's preview. The session's own file is the only permission: a
 * {@code run_step} {@code step_end} line of the asked run whose
 * {@code documents} name exactly that path. A document a step only reads is no
 * record. A {@code .env} file and anything under {@code .git} never open,
 * recorded or not, in any letter case, and neither does a recorded name that
 * is a link to one.
 *
 * <p>Driven through the request mapping, like
 * {@code WorkspaceControllerFenceTest}, so the parameter names and the
 * decoding of the path are part of what is tested. The setup is the one of
 * {@code WorkspaceControllerDotEntriesTest}: a session id, its resolved
 * workspace and a loopback request. The workspace is a folder inside the
 * temp folder, so a file outside it has somewhere to be.</p>
 */
class RunDocumentRouteTest {

    private static final String RUN = "aaaaaaaaaaaa";
    private static final String OTHER_RUN = "bbbbbbbbbbbb";
    private static final String CSP = "Content-Security-Policy";

    /** Holds the workspace and, beside it, the files outside the workspace. */
    @TempDir
    Path root;

    private Path workspace;
    private String session;
    private MockMvc mvc;
    private final List<String> sessions = new ArrayList<>();

    @BeforeEach
    void aSessionWithAResolvedWorkspace() throws IOException {
        workspace = Files.createDirectories(root.resolve("ws"));
        session = newSession();
        mvc = MockMvcBuilders.standaloneSetup(new WorkspaceController()).build();
    }

    @AfterEach
    void dropTheSessionFiles() throws IOException {
        for (String id : sessions) {
            Files.deleteIfExists(SessionStore.sessionFile(id));
        }
    }

    /** A session id whose resolved workspace is {@link #workspace}. */
    private String newSession() {
        String id = "rundoc-" + System.nanoTime();
        SessionWorkspaces.resolved(id, workspace.toString());
        sessions.add(id);
        return id;
    }

    private void write(String rel, String text) throws IOException {
        Path file = workspace.resolve(rel);
        Files.createDirectories(file.getParent());
        Files.writeString(file, text);
    }

    /** One step_end line of {@code run} in the session's file, naming {@code paths} as written. */
    private static void recordWritten(String sessionId, String run, String... paths) {
        List<RunEvent.RunDoc> documents = Arrays.stream(paths)
                .map(p -> new RunEvent.RunDoc("doc", p, "created"))
                .toList();
        new SessionStore(sessionId).append(stepEnd(run, documents));
    }

    private static RunEvent.RunStep stepEnd(String run, List<RunEvent.RunDoc> documents) {
        return new RunEvent.RunStep("playbook", run, "playbook", RunEvent.RunStep.STEP_END,
                "Write plan", null, null, "write_plan", "step", 1,
                null, null, null, null, null,
                null, null, null,
                null, null,
                "done", 12L, null, null,
                "written", 7, documents,
                null, null,
                null, null, null,
                System.currentTimeMillis());
    }

    private static RunEvent.RunStep stepStart(String run, List<RunEvent.RunDoc> reads,
                                              List<RunEvent.RunDoc> documents) {
        return new RunEvent.RunStep("playbook", run, "playbook", RunEvent.RunStep.STEP_START,
                "Write plan", null, null, "write_plan", "step", 1,
                "chat", null, "ollama", "qwen3:8b", null,
                "Write the plan.", 15, reads,
                null, null,
                null, null, null, null,
                null, null, documents,
                null, null,
                null, null, null,
                System.currentTimeMillis());
    }

    private MockHttpServletResponse ask(String sessionId, String run, String path) throws Exception {
        return mvc.perform(get("http://localhost/api/run-document")
                        .param("session", sessionId)
                        .param("run", run)
                        .param("path", path))
                .andReturn().getResponse();
    }

    /** The status for {@code path} in this test's session and run. */
    private int status(String path) throws Exception {
        return ask(session, RUN, path).getStatus();
    }

    private MockHttpServletResponse fileRoute(String path) throws Exception {
        return mvc.perform(get("http://localhost/api/file")
                        .param("path", path)
                        .param("session", session))
                .andReturn().getResponse();
    }

    @Test
    void aRecordedDocumentUnderADotFolderOpens() throws Exception {
        String rel = ".superpowers/sdd/x/task-1-report.md";
        write(rel, "# Task 1\n\nDone.\n");
        recordWritten(session, RUN, rel);

        MockHttpServletResponse res = ask(session, RUN, rel);

        assertThat(res.getStatus()).isEqualTo(200);
        assertThat(res.getContentAsString(StandardCharsets.UTF_8)).isEqualTo("# Task 1\n\nDone.\n");
        assertThat(res.getHeader(CSP)).isEqualTo("sandbox allow-scripts");
        assertThat(fileRoute(rel).getStatus()).as("the preview route keeps every dot path shut").isEqualTo(404);
    }

    @Test
    void aDocumentTheRunDidNotRecordIsRefused() throws Exception {
        write(".superpowers/sdd/x/task-1-report.md", "one");
        write(".superpowers/sdd/x/task-2-report.md", "two");
        recordWritten(session, RUN, ".superpowers/sdd/x/task-1-report.md");

        assertThat(status(".superpowers/sdd/x/task-2-report.md")).isEqualTo(404);
        assertThat(status(".superpowers/sdd/x/task-1-report.md")).as("the recorded neighbour").isEqualTo(200);
    }

    @Test
    void theRecordOfAnotherRunDoesNotOpenIt() throws Exception {
        write("docs/plan.md", "plan");
        recordWritten(session, OTHER_RUN, "docs/plan.md");

        assertThat(ask(session, RUN, "docs/plan.md").getStatus()).isEqualTo(404);
        assertThat(ask(session, OTHER_RUN, "docs/plan.md").getStatus()).as("the run that wrote it").isEqualTo(200);
    }

    @Test
    void theRecordOfAnotherSessionDoesNotOpenIt() throws Exception {
        write("docs/plan.md", "plan");
        write("docs/other.md", "other");
        String other = newSession(); // the same workspace, its own record
        recordWritten(other, RUN, "docs/other.md");
        recordWritten(session, RUN, "docs/plan.md");

        assertThat(ask(other, RUN, "docs/plan.md").getStatus()).isEqualTo(404);
        assertThat(ask(other, RUN, "docs/other.md").getStatus()).as("its own record").isEqualTo(200);
        assertThat(ask(session, RUN, "docs/plan.md").getStatus()).as("the session that recorded it").isEqualTo(200);
        assertThat(ask("rundoc-never-" + System.nanoTime(), RUN, "docs/plan.md").getStatus())
                .as("a session without a resolved workspace").isEqualTo(404);
    }

    @Test
    void aDocumentAStepOnlyReadsIsNotServed() throws Exception {
        write("docs/brief.md", "brief");
        write("docs/plan.md", "plan");
        new SessionStore(session).append(stepStart(RUN,
                List.of(new RunEvent.RunDoc("brief", "docs/brief.md", null)), null));
        recordWritten(session, RUN, "docs/plan.md");

        assertThat(status("docs/brief.md")).isEqualTo(404);
        assertThat(status("docs/plan.md")).as("what the step wrote").isEqualTo(200);
    }

    @Test
    void onlyAStepEndLineRecordsAWrittenDocument() throws Exception {
        // A documents list belongs to step_end. One on any other phase is not
        // what the runner writes, and it opens nothing.
        write("docs/plan.md", "plan");
        new SessionStore(session).append(stepStart(RUN, null,
                List.of(new RunEvent.RunDoc("plan", "docs/plan.md", "created"))));

        assertThat(status("docs/plan.md")).isEqualTo(404);

        recordWritten(session, RUN, "docs/plan.md");
        assertThat(status("docs/plan.md")).as("the same path once a step_end names it").isEqualTo(200);
    }

    @Test
    void anEnvFileIsNeverServedEvenWhenRecorded() throws Exception {
        write(".env", "KEY=not-a-real-key");
        write("conf/.env.local", "KEY=not-a-real-key");
        write("conf/settings.md", "settings");
        recordWritten(session, RUN, ".env", "conf/.env.local", "conf/settings.md");

        assertThat(status(".env")).isEqualTo(404);
        assertThat(status("conf/.env.local")).isEqualTo(404);
        assertThat(status("conf/settings.md")).as("a recorded neighbour").isEqualTo(200);
    }

    @Test
    void anEnvFileIsRefusedInAnyLetterCase() throws Exception {
        // APFS, the default macOS volume, ignores case: what dotenv opens as
        // .env is this file. The names on disk are upper case on purpose, so
        // the real path carries them too.
        write(".ENV", "KEY=not-a-real-key");
        write("conf/.Env.Local", "KEY=not-a-real-key");
        write("conf/Settings.MD", "settings");
        recordWritten(session, RUN, ".ENV", "conf/.Env.Local", "conf/Settings.MD");

        assertThat(status(".ENV")).isEqualTo(404);
        assertThat(status("conf/.Env.Local")).isEqualTo(404);
        assertThat(status("conf/Settings.MD")).as("a recorded neighbour").isEqualTo(200);
    }

    @Test
    void aGitPathIsNeverServedEvenWhenRecorded() throws Exception {
        write(".git/config", "[core]\n");
        write("sub/.git", "gitdir: ../.git/worktrees/sub\n"); // a worktree's .git is a file
        write(".gitignore", "build/\n");
        write(".github/workflows/ci.yml", "on: push\n");
        recordWritten(session, RUN, ".git/config", "sub/.git", ".gitignore", ".github/workflows/ci.yml");

        assertThat(status(".git/config")).isEqualTo(404);
        assertThat(status("sub/.git")).isEqualTo(404);
        assertThat(status(".gitignore")).as("only a segment named exactly .git is refused").isEqualTo(200);
        assertThat(status(".github/workflows/ci.yml")).isEqualTo(200);
    }

    @Test
    void aGitFolderIsRefusedInAnyLetterCase() throws Exception {
        write(".Git/config", "[core]\n");
        write("docs/notes.md", "notes");
        recordWritten(session, RUN, ".Git/config", "docs/notes.md");

        assertThat(status(".Git/config")).isEqualTo(404);
        assertThat(status("docs/notes.md")).as("a recorded neighbour").isEqualTo(200);
    }

    @Test
    void aRecordedNameThatLinksToAnEnvFileIsRefused() throws Exception {
        write(".env", "KEY=not-a-real-key");
        Files.createSymbolicLink(workspace.resolve("notes.md"), Path.of(".env"));
        write("plain.md", "plain");
        Files.createSymbolicLink(workspace.resolve("ok.md"), Path.of("plain.md"));
        recordWritten(session, RUN, "notes.md", "ok.md");

        assertThat(status("notes.md")).isEqualTo(404);
        assertThat(status("ok.md")).as("a recorded link to an ordinary file").isEqualTo(200);
    }

    @Test
    void aRecordedNameThatLinksIntoGitIsRefused() throws Exception {
        write(".git/config", "[core]\n");
        Files.createSymbolicLink(workspace.resolve("cfg.txt"), Path.of(".git/config"));
        write("docs/cfg.txt", "[core]\n");
        Files.createSymbolicLink(workspace.resolve("cfg-ok.txt"), Path.of("docs/cfg.txt"));
        recordWritten(session, RUN, "cfg.txt", "cfg-ok.txt");

        assertThat(status("cfg.txt")).isEqualTo(404);
        assertThat(status("cfg-ok.txt")).as("a recorded link to an ordinary file").isEqualTo(200);
    }

    @Test
    void aRecordedEnvNameIsRefusedAlsoWhenItLinksToAnOrdinaryFile() throws Exception {
        write("values.txt", "KEY=not-a-real-key");
        Files.createSymbolicLink(workspace.resolve(".env"), Path.of("values.txt"));
        recordWritten(session, RUN, ".env", "values.txt");

        assertThat(status(".env")).isEqualTo(404);
        assertThat(status("values.txt")).as("the target under its own recorded name").isEqualTo(200);
    }

    @Test
    void aRecordedGitPathIsRefusedAlsoWhenGitLinksToAnOrdinaryFolder() throws Exception {
        write("meta/config", "[core]\n");
        Files.createSymbolicLink(workspace.resolve(".git"), Path.of("meta"));
        recordWritten(session, RUN, ".git/config", "meta/config");

        assertThat(status(".git/config")).isEqualTo(404);
        assertThat(status("meta/config")).as("the target under its own recorded name").isEqualTo(200);
    }

    @Test
    void aLinkOutOfTheWorkspaceIsRefused() throws Exception {
        Files.writeString(root.resolve("outside.md"), "outside");
        Files.createSymbolicLink(workspace.resolve("out.md"), root.resolve("outside.md"));
        write("inside.md", "inside");
        Files.createSymbolicLink(workspace.resolve("in.md"), workspace.resolve("inside.md"));
        recordWritten(session, RUN, "out.md", "in.md");

        assertThat(status("out.md")).isEqualTo(404);
        assertThat(status("in.md")).as("a recorded link that stays inside").isEqualTo(200);
    }

    @Test
    void aRecordedLinkToAnOrdinaryFileInsideTheWorkspaceOpens() throws Exception {
        write("docs/plan.md", "# Plan\n");
        Files.createSymbolicLink(workspace.resolve("plan-link.md"), Path.of("docs/plan.md"));
        recordWritten(session, RUN, "plan-link.md");

        MockHttpServletResponse res = ask(session, RUN, "plan-link.md");

        assertThat(res.getStatus()).isEqualTo(200);
        assertThat(res.getContentAsString(StandardCharsets.UTF_8)).isEqualTo("# Plan\n");
    }

    @Test
    void aPathWithSpacesAndUnicodeOpens() throws Exception {
        String rel = "docs/Plan für Frogger.md";
        write(rel, "# Frogger\n");
        recordWritten(session, RUN, rel);

        // The template encodes the values into the query and the request
        // decodes them again, the way the browser's encodeURIComponent and the
        // servlet container meet.
        MvcResult result = mvc.perform(get("http://localhost/api/run-document?session={s}&run={r}&path={p}",
                session, RUN, rel)).andReturn();

        assertThat(result.getRequest().getQueryString()).contains("Plan%20f%C3%BCr%20Frogger.md");
        assertThat(result.getResponse().getStatus()).isEqualTo(200);
        assertThat(result.getResponse().getContentAsString(StandardCharsets.UTF_8)).isEqualTo("# Frogger\n");
    }

    @Test
    void aClimbingPathIsRefused() throws Exception {
        Files.writeString(root.resolve("x.md"), "outside"); // what ../x.md reaches from the workspace
        write("x.md", "inside");
        recordWritten(session, RUN, "../x.md", "x.md");

        assertThat(status("../x.md")).isEqualTo(404);
        assertThat(ask(session, RUN, "x.md").getContentAsString(StandardCharsets.UTF_8))
                .as("the same name inside the workspace").isEqualTo("inside");
    }

    @Test
    void aRecordedFolderOrAMissingFileIsRefused() throws Exception {
        Files.createDirectories(workspace.resolve("docs"));
        recordWritten(session, RUN, "docs", "gone.md");

        assertThat(status("docs")).isEqualTo(404);
        assertThat(status("gone.md")).isEqualTo(404);

        write("gone.md", "back");
        assertThat(status("gone.md")).as("the same record once the file is there").isEqualTo(200);
    }

    @Test
    void aRecordedPathTheFileSystemCannotNameIsRefused() throws Exception {
        // A NUL character fits in a JSON string and in a query parameter, but
        // no file name can hold it. The route answers such a path with 404.
        recordWritten(session, RUN, "docs/a\u0000b.md", "docs/ab.md");
        write("docs/ab.md", "ab");

        assertThat(status("docs/a\u0000b.md")).isEqualTo(404);
        assertThat(status("docs/ab.md")).as("a recorded neighbour").isEqualTo(200);
    }

    @Test
    void aSessionWithAWorkspaceButNoSessionFileGetsNothing() throws Exception {
        // A new chat after a folder pick: the workspace is resolved, the session
        // file does not exist yet. An unreadable record is no record.
        String fresh = newSession();
        write(".superpowers/x.md", "x");
        assertThat(Files.exists(SessionStore.sessionFile(fresh))).as("premise: no session file").isFalse();

        assertThat(ask(fresh, RUN, ".superpowers/x.md").getStatus()).isEqualTo(404);

        recordWritten(fresh, RUN, ".superpowers/x.md");
        assertThat(ask(fresh, RUN, ".superpowers/x.md").getStatus()).as("once it records the file").isEqualTo(200);
    }

    @Test
    void aWorkspaceInsideAGitFolderServesNothing() throws Exception {
        Path inGit = Files.createDirectories(root.resolve(".git/inner"));
        Path plain = Files.createDirectories(root.resolve("plain/inner"));
        for (Path folder : List.of(inGit, plain)) {
            Files.writeString(folder.resolve("notes.md"), "notes");
        }
        String gitSession = "rundoc-git-" + System.nanoTime();
        String plainSession = "rundoc-plain-" + System.nanoTime();
        SessionWorkspaces.resolved(gitSession, inGit.toString());
        SessionWorkspaces.resolved(plainSession, plain.toString());
        sessions.add(gitSession);
        sessions.add(plainSession);
        recordWritten(gitSession, RUN, "notes.md");
        recordWritten(plainSession, RUN, "notes.md");

        assertThat(ask(gitSession, RUN, "notes.md").getStatus()).isEqualTo(404);
        assertThat(ask(plainSession, RUN, "notes.md").getStatus()).as("the same layout elsewhere").isEqualTo(200);
    }

    /** A run_start line of {@code run} carrying {@code fingerprint}, or none. */
    private static void recordStart(String sessionId, String run, String fingerprint) {
        new SessionStore(sessionId).append(new RunEvent.RunStep("playbook", run, "playbook",
                RunEvent.RunStep.RUN_START, "T", "a task", List.of(new RunEvent.RunNode("write_plan", "Write plan", "step")),
                null, null, null, null, null, null, null, null, null, null, null, null, null,
                null, null, null, null, null, null, null, null, null, null, null, null,
                System.currentTimeMillis(), fingerprint));
    }

    @Test
    void aRunBoundToTheSessionsFolderOpensItsDocument() throws Exception {
        // The session names its folder through a link; the run fingerprinted the
        // real path. The route compares real paths, so the two match.
        Path link = Files.createSymbolicLink(root.resolve("ws-link"), workspace);
        String linked = "rundoc-link-" + System.nanoTime();
        SessionWorkspaces.resolved(linked, link.toString());
        sessions.add(linked);
        write("docs/plan.md", "plan");
        recordStart(linked, RUN, RunEvent.RunStep.fingerprintOf(workspace.toRealPath()));
        recordWritten(linked, RUN, "docs/plan.md");

        assertThat(ask(linked, RUN, "docs/plan.md").getStatus()).isEqualTo(200);
    }

    @Test
    void aRunThatWroteInAnotherFolderOpensNothingHere() throws Exception {
        // The session's folder changed after the run: a resumed session whose
        // recorded folder is gone falls back to another one.
        Path elsewhere = Files.createDirectories(root.resolve("elsewhere"));
        write("docs/plan.md", "plan");
        recordStart(session, RUN, RunEvent.RunStep.fingerprintOf(elsewhere.toRealPath()));
        recordWritten(session, RUN, "docs/plan.md");
        recordStart(session, OTHER_RUN, RunEvent.RunStep.fingerprintOf(workspace.toRealPath()));
        recordWritten(session, OTHER_RUN, "docs/plan.md");

        assertThat(ask(session, RUN, "docs/plan.md").getStatus()).isEqualTo(404);
        assertThat(ask(session, OTHER_RUN, "docs/plan.md").getStatus()).as("a run of this folder").isEqualTo(200);
    }

    @Test
    void aRunStartWithoutAFingerprintKeepsTheOldBehaviour() throws Exception {
        write("docs/plan.md", "plan");
        recordStart(session, RUN, null);
        recordWritten(session, RUN, "docs/plan.md");

        assertThat(ask(session, RUN, "docs/plan.md").getStatus()).isEqualTo(200);
    }

    @Test
    void anOrdinaryDotFileStillOpens() throws Exception {
        write(".editorconfig", "root = true\n");
        write("docs/keys.md", "keys");
        write("ssh-notes.md", "notes");
        recordWritten(session, RUN, ".editorconfig", "docs/keys.md", "ssh-notes.md");

        assertThat(status(".editorconfig")).isEqualTo(200);
        assertThat(status("docs/keys.md")).isEqualTo(200);
        assertThat(status("ssh-notes.md")).isEqualTo(200);
    }

    @Test
    void anEnvrcIsRefused() throws Exception {
        assertRefusedWhenRecorded(".envrc", "sub/.EnvRC");
    }

    @Test
    void aNameStartingWithEnvDashIsRefused() throws Exception {
        assertRefusedWhenRecorded(".env-prod", "conf/.ENV-staging");
    }

    @Test
    void aNetrcIsRefused() throws Exception {
        assertRefusedWhenRecorded(".netrc", "home/.NETRC");
    }

    @Test
    void anNpmrcIsRefused() throws Exception {
        assertRefusedWhenRecorded(".npmrc", "web/.Npmrc");
    }

    @Test
    void aPemFileIsRefused() throws Exception {
        assertRefusedWhenRecorded("certs/server.pem", "certs/CA.PEM");
    }

    @Test
    void aKeyFileIsRefused() throws Exception {
        assertRefusedWhenRecorded("certs/server.key", "certs/Signing.KEY");
    }

    @Test
    void aP12FileIsRefused() throws Exception {
        assertRefusedWhenRecorded("certs/store.p12", "certs/Backup.P12");
    }

    @Test
    void aPfxFileIsRefused() throws Exception {
        assertRefusedWhenRecorded("certs/store.pfx", "certs/Backup.PFX");
    }

    @Test
    void anAwsFolderIsRefused() throws Exception {
        assertRefusedWhenRecorded(".aws/credentials", "home/.AWS/config");
    }

    @Test
    void anSshFolderIsRefused() throws Exception {
        assertRefusedWhenRecorded(".ssh/id_ed25519", "home/.Ssh/known_hosts");
    }

    @Test
    void aRecordedNameThatLinksIntoAnSshFolderIsRefused() throws Exception {
        write(".ssh/id_ed25519", "not-a-real-key");
        Files.createSymbolicLink(workspace.resolve("notes.txt"), Path.of(".ssh/id_ed25519"));
        recordWritten(session, RUN, "notes.txt");

        assertThat(status("notes.txt")).isEqualTo(404);
    }

    /**
     * Writes and records each path beside an ordinary neighbour, then expects
     * 404 for each path and 200 for the neighbour. The upper-case variant of
     * each rule has a name of its own: on a volume that ignores case,
     * {@code store.p12} and {@code Store.P12} are one file, stored under the
     * first name, and the case of the real path would never be tested.
     */
    private void assertRefusedWhenRecorded(String... paths) throws Exception {
        write("docs/neighbour.md", "neighbour");
        for (String path : paths) {
            write(path, "not-a-real-secret");
        }
        List<String> all = new java.util.ArrayList<>(List.of(paths));
        all.add("docs/neighbour.md");
        recordWritten(session, RUN, all.toArray(String[]::new));

        for (String path : paths) {
            assertThat(status(path)).as(path).isEqualTo(404);
        }
        assertThat(status("docs/neighbour.md")).as("a recorded neighbour").isEqualTo(200);
    }

    @Test
    void aForeignCallerGetsNothing() throws Exception {
        write("docs/plan.md", "plan");
        recordWritten(session, RUN, "docs/plan.md");

        int rebound = mvc.perform(get("http://evil.example/api/run-document")
                        .param("session", session).param("run", RUN).param("path", "docs/plan.md"))
                .andReturn().getResponse().getStatus();
        int remotePeer = mvc.perform(get("http://localhost/api/run-document")
                        .param("session", session).param("run", RUN).param("path", "docs/plan.md")
                        .with(request -> {
                            request.setRemoteAddr("192.0.2.1"); // TEST-NET-1, not loopback
                            return request;
                        }))
                .andReturn().getResponse().getStatus();

        assertThat(rebound).as("a rebound Host").isEqualTo(404);
        assertThat(remotePeer).as("a peer that is not loopback").isEqualTo(404);
        assertThat(status("docs/plan.md")).as("the loopback caller").isEqualTo(200);
    }

    @Test
    void aMalformedRunIdIsABadRequest() throws Exception {
        write("docs/plan.md", "plan");
        recordWritten(session, "zz", "docs/plan.md");

        assertThat(ask(session, "zz", "docs/plan.md").getStatus()).isEqualTo(400);
        assertThat(ask(session, "AAAAAAAAAAAA", "docs/plan.md").getStatus()).as("upper case").isEqualTo(400);
        assertThat(ask(session, "aaaaaaaaaaaaa", "docs/plan.md").getStatus()).as("13 characters").isEqualTo(400);
        assertThat(ask("a/b", RUN, "docs/plan.md").getStatus()).as("a malformed session id").isEqualTo(400);
    }

    @Test
    void answersWithTheBytesAndHeadersOfTheFileRoute() throws Exception {
        write("docs/plan.md", "# Plan\n");
        write("page.html", "<p>hi</p>");
        Path png = workspace.resolve("img/dot.png");
        Files.createDirectories(png.getParent());
        Files.write(png, new byte[] {(byte) 0x89, 'P', 'N', 'G', 0, 1, 2});
        recordWritten(session, RUN, "docs/plan.md", "page.html", "img/dot.png");

        for (String rel : List.of("docs/plan.md", "page.html", "img/dot.png")) {
            MockHttpServletResponse viaRun = ask(session, RUN, rel);
            MockHttpServletResponse viaFile = fileRoute(rel);
            assertThat(viaRun.getStatus()).as(rel).isEqualTo(200).isEqualTo(viaFile.getStatus());
            assertThat(viaRun.getContentType()).as(rel).isEqualTo(viaFile.getContentType());
            assertThat(viaRun.getHeader(CSP)).as(rel).isEqualTo(viaFile.getHeader(CSP));
            assertThat(viaRun.getContentAsByteArray()).as(rel).isEqualTo(viaFile.getContentAsByteArray());
        }
    }

    @Test
    void aBinaryOrOversizedRecordedFileAnswersAsTheFileRouteDoes() throws Exception {
        Files.write(workspace.resolve("blob.bin"), new byte[] {1, 0, 2});
        Files.writeString(workspace.resolve("big.txt"), "x".repeat(2 * 1024 * 1024 + 1));
        recordWritten(session, RUN, "blob.bin", "big.txt");

        assertThat(status("blob.bin")).isEqualTo(415);
        assertThat(status("big.txt")).isEqualTo(413);
    }
}
