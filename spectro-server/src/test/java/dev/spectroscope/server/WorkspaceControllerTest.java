package dev.spectroscope.server;

import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import org.springframework.http.ResponseEntity;

import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;

import static org.assertj.core.api.Assertions.assertThat;

class WorkspaceControllerTest {

    @TempDir
    Path root;

    private WorkspaceController controller() {
        return new WorkspaceController(root);
    }

    @Test
    void listsTheTreeDirsFirstSkippingHiddenAndIgnored() throws Exception {
        Files.createDirectories(root.resolve("src/app"));
        Files.writeString(root.resolve("src/app/Main.java"), "class Main {}");
        Files.writeString(root.resolve("README.md"), "# hello");
        Files.createDirectories(root.resolve("node_modules/x"));
        Files.createDirectories(root.resolve(".git"));
        Files.writeString(root.resolve(".env"), "SECRET=1");

        WorkspaceController.FilesResponse res = controller().files(null).getBody();

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
        WorkspaceController.FilesResponse res = controller().files(null).getBody();
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

        ResponseEntity<byte[]> res = controller().file("notes.txt", null);

        assertThat(res.getStatusCode().value()).isEqualTo(200);
        assertThat(new String(res.getBody())).contains("hello workspace");
        assertThat(res.getHeaders().getContentType().toString()).startsWith("text/plain");
        assertThat(res.getHeaders().getFirst("Content-Security-Policy")).isEqualTo("sandbox allow-scripts");
    }

    @Test
    void servesHtmlAsTextHtmlSandboxed() throws Exception {
        Files.writeString(root.resolve("page.html"), "<h1>hi</h1><script>1</script>");

        ResponseEntity<byte[]> res = controller().file("page.html", null);

        assertThat(res.getStatusCode().value()).isEqualTo(200);
        assertThat(res.getHeaders().getContentType().toString()).startsWith("text/html");
        assertThat(res.getHeaders().getFirst("Content-Security-Policy")).isEqualTo("sandbox allow-scripts");
    }

    @Test
    void servesImagesWithTheirContentType() throws Exception {
        Files.write(root.resolve("dot.png"), new byte[] {(byte) 0x89, 'P', 'N', 'G', 0, 1, 2});

        ResponseEntity<byte[]> res = controller().file("dot.png", null);

        assertThat(res.getStatusCode().value()).isEqualTo(200);
        assertThat(res.getHeaders().getContentType().toString()).isEqualTo("image/png");
    }

    @Test
    void refusesTraversalHiddenAndIgnoredPaths() throws Exception {
        Files.writeString(root.resolve(".env"), "SECRET=1");
        Files.createDirectories(root.resolve("node_modules"));
        Files.writeString(root.resolve("node_modules/pkg.json"), "{}");

        assertThat(controller().file("../outside.txt", null).getStatusCode().value()).isEqualTo(404);
        assertThat(controller().file(".env", null).getStatusCode().value()).isEqualTo(404);
        assertThat(controller().file("node_modules/pkg.json", null).getStatusCode().value()).isEqualTo(404);
    }

    @Test
    void binaryFilesGet415AndOversizedText413() throws Exception {
        Files.write(root.resolve("blob.bin"), new byte[] {1, 0, 2, 0, 3});
        byte[] big = new byte[(int) (2L * 1024 * 1024) + 1];
        java.util.Arrays.fill(big, (byte) 'a');
        Files.write(root.resolve("big.txt"), big);

        assertThat(controller().file("blob.bin", null).getStatusCode().value()).isEqualTo(415);
        assertThat(controller().file("big.txt", null).getStatusCode().value()).isEqualTo(413);
    }

    @Test
    void missingFileIs404() {
        assertThat(controller().file("nope.txt", null).getStatusCode().value()).isEqualTo(404);
    }

    @Test
    void aMalformedSessionIdIs400() {
        assertThat(controller().files("../evil").getStatusCode().value()).isEqualTo(400);
        assertThat(controller().file("x.txt", "a/b").getStatusCode().value()).isEqualTo(400);
    }

    @Test
    void anUnknownSessionWorkspaceIs404() {
        assertThat(controller().files("no-such-session-workspace-xyz").getStatusCode().value())
                .isEqualTo(404);
    }

    @Test
    void aSessionParameterServesThatSessionsWorkspace(@TempDir Path elsewhere) throws Exception {
        // The configured-workspace seam stands in for ~/.spectro config: with a
        // session id, the controller resolves via WorkspaceResolver.locate and
        // serves THAT folder — the boot root is not consulted at all.
        WorkspaceController controller = new WorkspaceController(root, () -> elsewhere.toString());
        Files.writeString(elsewhere.resolve("made-by-agent.py"), "print('hi')");

        var res = controller.files("some-session-id");
        assertThat(res.getStatusCode().value()).isEqualTo(200);
        assertThat(res.getBody().entries()).extracting(WorkspaceController.FileNode::name)
                .contains("made-by-agent.py");

        var content = controller.file("made-by-agent.py", "some-session-id");
        assertThat(content.getStatusCode().value()).isEqualTo(200);
        assertThat(new String(content.getBody())).contains("print('hi')");
    }
}
