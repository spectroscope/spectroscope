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
    void listsTheTreeDirsFirstSkippingHiddenAndIgnored() throws Exception {
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
                .containsExactly("src", "README.md"); // dirs first, hidden/ignored gone
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
