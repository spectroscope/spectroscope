package dev.spectroscope.server;

import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import org.springframework.mock.web.MockHttpServletRequest;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Map;

import static org.junit.jupiter.api.Assertions.assertArrayEquals;
import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNull;

/**
 * The gallery's copy-to-workspace endpoint, proven through the seams — a temp
 * image store and a temp workspace, no user home and no real session. The
 * guards are the point: the local-origin write fence, store-name shape,
 * session-id shape, sanitized target name, no overwrite.
 */
class ImageCopyControllerTest {

    private static final String STORE_NAME = "a".repeat(64) + ".png";
    private static final byte[] PNG = {(byte) 0x89, 'P', 'N', 'G'};

    private ImageCopyController controller(Path imagesDir, Path workspace) {
        return new ImageCopyController(imagesDir, workspace::toString);
    }

    /** A legitimate operator request: loopback peer + localhost Host. */
    private static MockHttpServletRequest local() {
        return new MockHttpServletRequest();
    }

    private Path plantImage(Path imagesDir) throws IOException {
        Files.createDirectories(imagesDir);
        Path source = imagesDir.resolve(STORE_NAME);
        Files.write(source, PNG);
        return source;
    }

    @Test
    void copiesUnderTheOriginalNameByDefault(@TempDir Path imagesDir, @TempDir Path workspace)
            throws IOException {
        plantImage(imagesDir);
        var response = controller(imagesDir, workspace).copy(
                new ImageCopyController.CopyRequest(STORE_NAME, "s-1", null), local());

        assertEquals(200, response.getStatusCode().value());
        assertEquals(Map.of("path", STORE_NAME), response.getBody());
        assertArrayEquals(PNG, Files.readAllBytes(workspace.resolve(STORE_NAME)));
    }

    @Test
    void aCustomNameWithoutExtensionInheritsTheOriginals(@TempDir Path imagesDir, @TempDir Path workspace)
            throws IOException {
        plantImage(imagesDir);
        var response = controller(imagesDir, workspace).copy(
                new ImageCopyController.CopyRequest(STORE_NAME, "s-1", "strandkatze"), local());

        assertEquals(200, response.getStatusCode().value());
        assertEquals(Map.of("path", "strandkatze.png"), response.getBody());
        assertArrayEquals(PNG, Files.readAllBytes(workspace.resolve("strandkatze.png")));
    }

    @Test
    void refusesAnythingButAStoreNameAndAWellFormedSession(@TempDir Path imagesDir, @TempDir Path workspace) {
        var c = controller(imagesDir, workspace);
        assertEquals(400, c.copy(new ImageCopyController.CopyRequest(
                "../.env", "s-1", null), local()).getStatusCode().value());
        assertEquals(400, c.copy(new ImageCopyController.CopyRequest(
                STORE_NAME, "../x", null), local()).getStatusCode().value());
    }

    @Test
    void refusesTraversalTargetNames(@TempDir Path imagesDir, @TempDir Path workspace) throws IOException {
        plantImage(imagesDir);
        var response = controller(imagesDir, workspace).copy(
                new ImageCopyController.CopyRequest(STORE_NAME, "s-1", "../escape.png"), local());
        assertEquals(400, response.getStatusCode().value());
        assertNull(ImageCopyController.targetName(".hidden", STORE_NAME),
                "leading dots never become target names");
        assertNull(ImageCopyController.targetName("a/b.png", STORE_NAME),
                "separators never become target names");
    }

    @Test
    void neverOverwritesAnExistingFile(@TempDir Path imagesDir, @TempDir Path workspace) throws IOException {
        plantImage(imagesDir);
        Files.writeString(workspace.resolve("strandkatze.png"), "precious");
        var response = controller(imagesDir, workspace).copy(
                new ImageCopyController.CopyRequest(STORE_NAME, "s-1", "strandkatze"), local());

        assertEquals(409, response.getStatusCode().value());
        assertEquals("precious", Files.readString(workspace.resolve("strandkatze.png")),
                "the existing file stays untouched");
    }

    @Test
    void unknownImageAndMissingWorkspaceAnswer404(@TempDir Path imagesDir, @TempDir Path workspace)
            throws IOException {
        var noImage = controller(imagesDir, workspace).copy(
                new ImageCopyController.CopyRequest(STORE_NAME, "s-1", null), local());
        assertEquals(404, noImage.getStatusCode().value());

        plantImage(imagesDir);
        var noWorkspace = controller(imagesDir, workspace.resolve("does-not-exist")).copy(
                new ImageCopyController.CopyRequest(STORE_NAME, "s-1", null), local());
        assertEquals(404, noWorkspace.getStatusCode().value());
    }

    @Test
    void refusesADnsReboundHostAndWritesNothing(@TempDir Path imagesDir, @TempDir Path workspace)
            throws IOException {
        // The one filesystem-write endpoint must not plant a file for a rebound
        // page (loopback peer, attacker Host). 404, and nothing lands.
        plantImage(imagesDir);
        MockHttpServletRequest rebound = local();
        rebound.setServerName("attacker.example");
        var response = controller(imagesDir, workspace).copy(
                new ImageCopyController.CopyRequest(STORE_NAME, "s-1", null), rebound);
        assertEquals(404, response.getStatusCode().value());
        assertFalse(Files.exists(workspace.resolve(STORE_NAME)), "nothing written");
    }

    @Test
    void refusesACrossSiteOrigin(@TempDir Path imagesDir, @TempDir Path workspace) throws IOException {
        plantImage(imagesDir);
        MockHttpServletRequest crossSite = local();
        crossSite.addHeader("Origin", "https://evil.example");
        var response = controller(imagesDir, workspace).copy(
                new ImageCopyController.CopyRequest(STORE_NAME, "s-1", null), crossSite);
        assertEquals(404, response.getStatusCode().value());
        assertFalse(Files.exists(workspace.resolve(STORE_NAME)), "nothing written");
    }
}
