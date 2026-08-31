package dev.spectroscope.server.workspace;

import dev.spectroscope.server.session.SessionWorkspaces;

import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import org.springframework.http.ResponseEntity;
import org.springframework.mock.web.MockHttpServletRequest;

import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;

import static org.assertj.core.api.Assertions.assertThat;

class WorkspaceControllerTest {

    @TempDir
    Path root;

    /** A session id that really has a workspace, the only door into the tree now. */
    private String session;

    @BeforeEach
    void registerTheSessionsWorkspace() {
        // Stands in for the socket having resolved a workspace for this session.
        // The controller used to reach the same folder through the process cwd
        // or through a configured path with no session behind it; both doors
        // are gone, so the tests walk in the way the app does.
        session = "ws-test-" + System.nanoTime();
        SessionWorkspaces.resolved(session, root.toString());
    }

    /** A loopback request with a localhost Host, i.e. what the real UI sends. */
    private static MockHttpServletRequest local() {
        return new MockHttpServletRequest();
    }

    private WorkspaceController controller() {
        return new WorkspaceController();
    }

    @Test
    void listsTheTreeDirsFirstPruningTheIgnoredDirectoriesOnly() throws Exception {
        // Replaced rather than loosened (card 351): this test used to say
        // "SkippingHiddenAndIgnored" and pinned a tree with no dot-entries in
        // it, which is the behaviour the card removes. The threshold it really
        // guards — dirs before files, ignored directories gone — is unchanged,
        // and the claim underneath it is now the new one.
        Files.createDirectories(root.resolve("src/app"));
        Files.writeString(root.resolve("src/app/Main.java"), "class Main {}");
        Files.writeString(root.resolve("README.md"), "# hello");
        Files.createDirectories(root.resolve("node_modules/x"));
        Files.createDirectories(root.resolve(".git"));
        Files.writeString(root.resolve(".env"), "SECRET=1");

        WorkspaceController.FilesResponse res =
                (WorkspaceController.FilesResponse) controller().files(session, null, local()).getBody();

        assertThat(res.truncated()).isFalse();
        assertThat(res.entries()).extracting(WorkspaceController.FileNode::name)
                // dirs first, ignored gone, the dot-file visible and still unreadable
                .containsExactly("src", ".env", "README.md");
        WorkspaceController.FileNode src = res.entries().get(0);
        assertThat(src.dir()).isTrue();
        assertThat(src.children()).hasSize(1);
        WorkspaceController.FileNode app = src.children().get(0);
        assertThat(app.path()).isEqualTo("src/app");
        assertThat(app.children().get(0).path()).isEqualTo("src/app/Main.java");
        assertThat(app.children().get(0).size()).isGreaterThan(0);
    }

    @Test
    void capsTheListingAndSaysSo() throws Exception {
        for (int i = 0; i < 2100; i++) {
            Files.writeString(root.resolve("f" + i + ".txt"), "x");
        }
        WorkspaceController.FilesResponse res =
                (WorkspaceController.FilesResponse) controller().files(session, null, local()).getBody();
        assertThat(res.truncated()).isTrue();
        assertThat(countNodes(res.entries())).isLessThanOrEqualTo(2000);
    }

    @Test
    void aHugeCacheDirectoryCannotStarveTheOperatorsOwnFiles() throws Exception {
        // Card 351 criterion 4, measured rather than assumed. Dot names sort
        // FIRST ('.' is 0x2E, ahead of every letter), so the moment dot-entries
        // became visible a dependency cache beside the operator's source moved
        // to the head of the walk. Under a depth-first walk on ONE shared
        // budget it then drank the whole 2000 before src was ever reached and
        // the top level came back as a single truncated entry.
        //
        // The name here is deliberately NOT on PRUNED_NAMES: adding names is a
        // hand-list and this has to hold for the cache nobody listed yet.
        Files.createDirectories(root.resolve(".aaa-cache/pkg"));
        for (int i = 0; i < 2500; i++) {
            Files.writeString(root.resolve(".aaa-cache/pkg/m" + i + ".py"), "x");
        }
        Files.createDirectories(root.resolve("src"));
        for (String f : new String[] {"Main.java", "Other.java", "Third.java", "Fourth.java"}) {
            Files.writeString(root.resolve("src").resolve(f), "class X {}");
        }
        Files.writeString(root.resolve("README.md"), "# hello");

        WorkspaceController.FilesResponse res =
                (WorkspaceController.FilesResponse) controller().files(session, null, local()).getBody();

        assertThat(res.entries()).extracting(WorkspaceController.FileNode::name)
                .containsExactly(".aaa-cache", "src", "README.md");
        WorkspaceController.FileNode src = res.entries().stream()
                .filter(n -> n.name().equals("src")).findFirst().orElseThrow();
        assertThat(src.children()).extracting(WorkspaceController.FileNode::name)
                .containsExactly("Fourth.java", "Main.java", "Other.java", "Third.java");
        assertThat(res.truncated()).isTrue();
        assertThat(countNodes(res.entries())).isLessThanOrEqualTo(2000);
    }

    @Test
    void theBoundOnWhatOneDirectoryHoldsCostsTheListingNothing() throws Exception {
        // The fair walk keeps a whole LEVEL of directories open at once, so a
        // cursor keeps only the head of its directory (CURSOR_KEEP). The bound
        // has to be invisible: a full 2000 real entries, the pruned names gone,
        // and truncated still seeing that something was left standing.
        //
        // The "z" is the whole test. Every pruned name must sort AHEAD of every
        // real one, or the head has slack the bound was never given: with "f"
        // names three of the thirteen ("node_modules", "out", "target") fall
        // behind them, and dropping the "+ 1" then stays GREEN. That was the
        // first version of this test, and the bite came back green — measured,
        // not reasoned about.
        for (String pruned : WorkspaceController.PRUNED_NAMES) {
            Files.writeString(root.resolve(pruned), "noise");
        }
        for (int i = 0; i < 2005; i++) {
            Files.writeString(root.resolve(String.format("z%04d.txt", i)), "x");
        }

        WorkspaceController.FilesResponse res =
                (WorkspaceController.FilesResponse) controller().files(session, null, local()).getBody();

        assertThat(res.entries()).hasSize(2000);
        assertThat(res.entries()).extracting(WorkspaceController.FileNode::name)
                .doesNotContainAnyElementsOf(WorkspaceController.PRUNED_NAMES)
                .startsWith("z0000.txt");
        assertThat(res.truncated()).isTrue();
    }

    @Test
    void siblingsAtOneLevelShareTheBudgetInTurn() throws Exception {
        // The OTHER half of the starvation fix, and the half nothing measured.
        // Going level by level saves the operator's TOP level on its own: in
        // aHugeCacheDirectoryCannotStarveTheOperatorsOwnFiles the cache's 2500
        // files sit one level below the cursor that competes with src, so a walk
        // that drained each directory in turn instead of taking turns passes
        // that test unchanged. Measured before this test existed, not reasoned
        // about: with the round robin replaced by a drain, the whole
        // spectro-server module stayed green — 118 classes, 875 tests, 0
        // failures, the same counts as the unmutated run beside it. The commit
        // message of 87d7dad2 recorded that mutation as "2 red, incl. the cap
        // test", and it was not: the guard was missing, and this is it.
        //
        // Here the cache is the small folder's own SIBLING, so only the turn
        // taking can save it. One entry per open directory per round means the
        // four files arrive in the first four rounds, whatever the neighbour
        // holds.
        Files.createDirectories(root.resolve("aaa-cache"));
        for (int i = 0; i < 2500; i++) {
            Files.writeString(root.resolve("aaa-cache/m" + i + ".py"), "x");
        }
        Files.createDirectories(root.resolve("zzz-src"));
        for (String f : new String[] {"Main.java", "Other.java", "Third.java", "Fourth.java"}) {
            Files.writeString(root.resolve("zzz-src").resolve(f), "class X {}");
        }

        WorkspaceController.FilesResponse res =
                (WorkspaceController.FilesResponse) controller().files(session, null, local()).getBody();

        WorkspaceController.FileNode small = res.entries().stream()
                .filter(n -> n.name().equals("zzz-src")).findFirst().orElseThrow();
        assertThat(small.children()).extracting(WorkspaceController.FileNode::name)
                .containsExactly("Fourth.java", "Main.java", "Other.java", "Third.java");
        assertThat(res.truncated())
                .as("the budget really is under pressure, or this measures nothing")
                .isTrue();
    }

    @Test
    void aDirectoryCutShortByTheCursorBoundNeverPassesAsWhole(@TempDir Path outside) throws Exception {
        // The bound CURSOR_KEEP cuts the sorted child list in openInto, BEFORE
        // Cursor#peek runs the escaped-symlink filter over what survived, and
        // that filter has no bound at all. Its arithmetic only ever accounted
        // for PRUNED_NAMES. So a directory whose head is links out of the
        // workspace can have the whole of its kept head thrown away, its real
        // files past the cut never looked at, and the budget never touched —
        // which is the one shape a listing must not have: short, and claiming
        // to be whole.
        //
        // The counts come off the constants, not out of this comment: one more
        // escaping link than the bound's slack (CURSOR_KEEP - MAX_ENTRIES), so
        // what is kept can no longer fill the budget and the cursor runs dry
        // with budget to spare.
        int escapes = WorkspaceController.CURSOR_KEEP - WorkspaceController.MAX_ENTRIES + 1;
        for (int i = 0; i < escapes; i++) {
            // "aaa" sorts ahead of the real files, and a link to a directory
            // sorts with the directories, i.e. first of all.
            Files.createSymbolicLink(root.resolve(String.format("aaa%03d", i)), outside);
        }
        int real = WorkspaceController.CURSOR_KEEP + 100;
        for (int i = 0; i < real; i++) {
            Files.writeString(root.resolve(String.format("z%05d.txt", i)), "x");
        }

        WorkspaceController.FilesResponse res =
                (WorkspaceController.FilesResponse) controller().files(session, null, local()).getBody();

        assertThat(res.entries()).extracting(WorkspaceController.FileNode::name)
                .as("a link out of the workspace is not part of the workspace")
                .noneMatch(n -> n.startsWith("aaa"));
        assertThat(res.entries().size())
                .as("entries were dropped: the head was cut and then filtered away")
                .isLessThan(real);
        assertThat(res.truncated())
                .as("and the response has to say so")
                .isTrue();
    }

    private static int countNodes(List<WorkspaceController.FileNode> nodes) {
        int n = 0;
        for (WorkspaceController.FileNode node : nodes) {
            n += 1 + countNodes(node.children());
        }
        return n;
    }

    @Test
    void servesTextWithCspSandboxHeader() throws Exception {
        Files.writeString(root.resolve("notes.txt"), "hello workspace");

        ResponseEntity<byte[]> res = controller().file("notes.txt", session, null, local());

        assertThat(res.getStatusCode().value()).isEqualTo(200);
        assertThat(new String(res.getBody())).contains("hello workspace");
        assertThat(res.getHeaders().getContentType().toString()).startsWith("text/plain");
        assertThat(res.getHeaders().getFirst("Content-Security-Policy")).isEqualTo("sandbox allow-scripts");
    }

    @Test
    void servesHtmlAsTextHtmlSandboxed() throws Exception {
        Files.writeString(root.resolve("page.html"), "<h1>hi</h1><script>1</script>");

        ResponseEntity<byte[]> res = controller().file("page.html", session, null, local());

        assertThat(res.getStatusCode().value()).isEqualTo(200);
        assertThat(res.getHeaders().getContentType().toString()).startsWith("text/html");
        assertThat(res.getHeaders().getFirst("Content-Security-Policy")).isEqualTo("sandbox allow-scripts");
    }

    @Test
    void servesImagesWithTheirContentType() throws Exception {
        Files.write(root.resolve("dot.png"), new byte[] {(byte) 0x89, 'P', 'N', 'G', 0, 1, 2});

        ResponseEntity<byte[]> res = controller().file("dot.png", session, null, local());

        assertThat(res.getStatusCode().value()).isEqualTo(200);
        assertThat(res.getHeaders().getContentType().toString()).isEqualTo("image/png");
    }

    @Test
    void refusesTraversalHiddenAndIgnoredPaths() throws Exception {
        Files.writeString(root.resolve(".env"), "SECRET=1");
        Files.createDirectories(root.resolve("node_modules"));
        Files.writeString(root.resolve("node_modules/pkg.json"), "{}");

        assertThat(controller().file("../outside.txt", session, null, local()).getStatusCode().value()).isEqualTo(404);
        assertThat(controller().file(".env", session, null, local()).getStatusCode().value()).isEqualTo(404);
        assertThat(controller().file("node_modules/pkg.json", session, null, local()).getStatusCode().value()).isEqualTo(404);
    }

    @Test
    void binaryFilesGet415AndOversizedText413() throws Exception {
        Files.write(root.resolve("blob.bin"), new byte[] {1, 0, 2, 0, 3});
        byte[] big = new byte[(int) (2L * 1024 * 1024) + 1];
        java.util.Arrays.fill(big, (byte) 'a');
        Files.write(root.resolve("big.txt"), big);

        assertThat(controller().file("blob.bin", session, null, local()).getStatusCode().value()).isEqualTo(415);
        assertThat(controller().file("big.txt", session, null, local()).getStatusCode().value()).isEqualTo(413);
    }

    @Test
    void missingFileIs404() {
        assertThat(controller().file("nope.txt", session, null, local()).getStatusCode().value()).isEqualTo(404);
    }

    @Test
    void aMalformedSessionIdIs400() {
        assertThat(controller().files("../evil", null, local()).getStatusCode().value()).isEqualTo(400);
        assertThat(controller().file("x.txt", "a/b", null, local()).getStatusCode().value()).isEqualTo(400);
    }

    @Test
    void aResolvedWorkspaceWhoseFolderIsGoneIs404() {
        // The session resolved a workspace, but the folder is not on disk, the
        // honest 404 the pane reads as "not created yet", separate from the 409
        // that means no workspace was ever resolved.
        String gone = "ws-test-gone-" + System.nanoTime();
        SessionWorkspaces.resolved(gone, root.resolve("never-created").toString());

        assertThat(controller().files(gone, null, local()).getStatusCode().value()).isEqualTo(404);
    }

    @Test
    void filesWithoutSessionDoesNotServeTheProcessCwd() {
        // Production wiring rooted the controller at user.dir. On a developer
        // machine that is the product's OWN checkout, so a sessionless GET
        // handed the browser this repository: a browsing surface nobody
        // designed. There is no session behind such a request, so there is no
        // workspace to serve.
        ResponseEntity<?> res = controller().files(null, null, local());

        assertThat(res.getStatusCode().value()).isNotEqualTo(200);
    }

    @Test
    void filesWithoutSessionSaysNoWorkspaceIsResolved() {
        // Distinct from "the folder is not there yet" (404) and from a dead
        // server (no response at all): the pane must be able to say "no folder
        // yet" instead of "server unreachable".
        ResponseEntity<?> res = controller().files(null, null, local());

        assertThat(res.getStatusCode().value()).isEqualTo(409);
        assertThat(String.valueOf(res.getBody())).contains("no-workspace");
    }

    @Test
    void aSessionIdThatNeverExistedIsNotTreatedAsResolved() {
        // locate() short-circuits on a configured workspace and never looks at
        // the session id, so with one configured ANY id used to answer with that
        // folder as though it were the session's. A session that never resolved
        // a workspace has none, configured or not.
        ResponseEntity<?> res = controller().files("never-was-a-session-" + System.nanoTime(), null, local());

        assertThat(res.getStatusCode().value()).isNotEqualTo(200);
        assertThat(res.getStatusCode().value()).isEqualTo(409);
    }

    @Test
    void aSessionParameterServesThatSessionsWorkspace(@TempDir Path elsewhere) throws Exception {
        // Two sessions, two folders: each one is served its own, and the other
        // session's folder is never what comes back.
        String other = "ws-test-other-" + System.nanoTime();
        SessionWorkspaces.resolved(other, elsewhere.toString());
        Files.writeString(elsewhere.resolve("made-by-agent.py"), "print('hi')");
        Files.writeString(root.resolve("belongs-to-the-first-session.txt"), "mine");

        var res = controller().files(other, null, local());
        assertThat(res.getStatusCode().value()).isEqualTo(200);
        assertThat(((WorkspaceController.FilesResponse) res.getBody()).entries())
                .extracting(WorkspaceController.FileNode::name)
                .contains("made-by-agent.py")
                .doesNotContain("belongs-to-the-first-session.txt");

        var content = controller().file("made-by-agent.py", other, null, local());
        assertThat(content.getStatusCode().value()).isEqualTo(200);
        assertThat(new String(content.getBody())).contains("print('hi')");
    }

    @Test
    void aSymlinkOutOfTheWorkspaceIsNotAWayOut(@TempDir Path outside) throws Exception {
        // normalize() is lexical: it never touches the filesystem, so a link
        // named like an ordinary file survives every check the sandbox makes and
        // the read follows it. The workspace is a normal project folder the
        // agent can write to with run_command, so planting one is not exotic,
        // and the hide rule whose stated job is that ".env answers 404" is
        // defeated by a link called notes.txt.
        Files.writeString(outside.resolve("secret.txt"), "SECRET-OUTSIDE-THE-WORKSPACE");
        Files.createSymbolicLink(root.resolve("escape.txt"), outside.resolve("secret.txt"));
        Files.createSymbolicLink(root.resolve("uplink"), outside);

        assertThat(controller().file("escape.txt", session, null, local()).getStatusCode().value()).isEqualTo(404);
        assertThat(controller().file("uplink/secret.txt", session, null, local()).getStatusCode().value())
                .isEqualTo(404);
    }

    @Test
    void theLexicalEscapesStayClosed() {
        // The regression half: canonicalizing must not lose what already worked.
        assertThat(controller().file("../secret.txt", session, null, local()).getStatusCode().value()).isEqualTo(404);
        assertThat(controller().file("%2e%2e/secret.txt", session, null, local()).getStatusCode().value()).isEqualTo(404);
        assertThat(controller().file("/etc/passwd", session, null, local()).getStatusCode().value()).isEqualTo(404);
    }

    @Test
    void aFileInsideTheWorkspaceIsStillServedWhenTheRootItselfIsASymlink() throws Exception {
        // @TempDir on macOS hands out /var/... which is itself a link to
        // /private/var. Comparing a canonical path against a non-canonical base
        // would refuse every ordinary read on this machine, so both sides are
        // canonicalized and this test is what says so.
        Files.writeString(root.resolve("ordinary.txt"), "just a file");
        var res = controller().file("ordinary.txt", session, null, local());
        assertThat(res.getStatusCode().value()).isEqualTo(200);
        assertThat(new String(res.getBody())).isEqualTo("just a file");
    }
}
