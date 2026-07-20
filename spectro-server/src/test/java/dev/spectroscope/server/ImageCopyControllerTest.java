package dev.spectroscope.server;

import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Map;

import static org.junit.jupiter.api.Assertions.assertArrayEquals;
import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNull;

/**
 * The gallery's copy-to-workspace endpoint, proven through the seams — a temp
 * image store and a temp workspace, no user home and no real session. The
 * guards are the point: store-name shape, session-id shape, sanitized target
 * name, no overwrite.
 */
class ImageCopyControllerTest {

    private static final String STORE_NAME = "a".repeat(64) + ".png";
    private static final byte[] PNG = {(byte) 0x89, 'P', 'N', 'G'};

    private ImageCopyController controller(Path imagesDir, Path workspace) {
        return new ImageCopyController(imagesDir, workspace::toString);
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
                new ImageCopyController.CopyRequest(STORE_NAME, "s-1", null));

        assertEquals(200, response.getStatusCode().value());
        assertEquals(Map.of("path", STORE_NAME), response.getBody());
        assertArrayEquals(PNG, Files.readAllBytes(workspace.resolve(STORE_NAME)));
    }

    @Test
    void aCustomNameWithoutExtensionInheritsTheOriginals(@TempDir Path imagesDir, @TempDir Path workspace)
            throws IOException {
        plantImage(imagesDir);
        var response = controller(imagesDir, workspace).copy(
                new ImageCopyController.CopyRequest(STORE_NAME, "s-1", "strandkatze"));

        assertEquals(200, response.getStatusCode().value());
        assertEquals(Map.of("path", "strandkatze.png"), response.getBody());
        assertArrayEquals(PNG, Files.readAllBytes(workspace.resolve("strandkatze.png")));
    }

    @Test
    void refusesAnythingButAStoreNameAndAWellFormedSession(@TempDir Path imagesDir, @TempDir Path workspace) {
        var c = controller(imagesDir, workspace);
        assertEquals(400, c.copy(new ImageCopyController.CopyRequest(
                "../.env", "s-1", null)).getStatusCode().value());
        assertEquals(400, c.copy(new ImageCopyController.CopyRequest(
                STORE_NAME, "../x", null)).getStatusCode().value());
    }

    @Test
    void refusesTraversalTargetNames(@TempDir Path imagesDir, @TempDir Path workspace) throws IOException {
        plantImage(imagesDir);
        var response = controller(imagesDir, workspace).copy(
                new ImageCopyController.CopyRequest(STORE_NAME, "s-1", "../escape.png"));
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
                new ImageCopyController.CopyRequest(STORE_NAME, "s-1", "strandkatze"));

        assertEquals(409, response.getStatusCode().value());
        assertEquals("precious", Files.readString(workspace.resolve("strandkatze.png")),
                "the existing file stays untouched");
    }

    @Test
    void unknownImageAndMissingWorkspaceAnswer404(@TempDir Path imagesDir, @TempDir Path workspace)
            throws IOException {
        var noImage = controller(imagesDir, workspace).copy(
                new ImageCopyController.CopyRequest(STORE_NAME, "s-1", null));
        assertEquals(404, noImage.getStatusCode().value());

        plantImage(imagesDir);
        var noWorkspace = controller(imagesDir, workspace.resolve("does-not-exist")).copy(
                new ImageCopyController.CopyRequest(STORE_NAME, "s-1", null));
        assertEquals(404, noWorkspace.getStatusCode().value());
    }
}
