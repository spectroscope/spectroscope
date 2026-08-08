package dev.spectroscope.server.localmodel;

import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import java.io.ByteArrayInputStream;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.security.MessageDigest;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

/** The bundled-model download: streams the pinned GGUF, verifies its sha256, and
 *  moves it into ~/.spectro/models — atomically, so a failed or corrupt download
 *  never leaves a half file that looks ready. The HTTP fetch is a seam. */
class LocalModelDownloadTest {

    private static String sha256(byte[] b) throws Exception {
        byte[] d = MessageDigest.getInstance("SHA-256").digest(b);
        StringBuilder s = new StringBuilder();
        for (byte x : d) {
            s.append(String.format("%02x", x));
        }
        return s.toString();
    }

    private static void await(LocalModelDownload dl) throws InterruptedException {
        for (int i = 0; i < 200 && dl.status().get("state").equals("downloading"); i++) {
            Thread.sleep(20);
        }
    }

    @Test
    void aVerifiedDownloadLandsReady(@TempDir Path modelsDir) throws Exception {
        byte[] payload = "pretend-gguf-bytes".getBytes(StandardCharsets.UTF_8);
        LocalModelDownload dl = new LocalModelDownload(
                modelsDir, "m.gguf", sha256(payload), payload.length,
                url -> new ByteArrayInputStream(payload));

        assertEquals("absent", dl.status().get("state"));
        dl.start();
        await(dl);

        assertEquals("ready", dl.status().get("state"));
        assertTrue(Files.exists(modelsDir.resolve("m.gguf")));
        assertEquals(new String(payload, StandardCharsets.UTF_8),
                Files.readString(modelsDir.resolve("m.gguf")));
    }

    @Test
    void aChecksumMismatchFailsAndWritesNothing(@TempDir Path modelsDir) throws Exception {
        byte[] payload = "corrupt".getBytes(StandardCharsets.UTF_8);
        LocalModelDownload dl = new LocalModelDownload(
                modelsDir, "m.gguf", "0".repeat(64), payload.length,   // wrong sha256
                url -> new ByteArrayInputStream(payload));

        dl.start();
        await(dl);

        assertEquals("failed", dl.status().get("state"));
        assertFalse(Files.exists(modelsDir.resolve("m.gguf")), "a corrupt download leaves no file");
    }
}
