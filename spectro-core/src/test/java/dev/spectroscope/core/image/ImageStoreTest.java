package dev.spectroscope.core.image;

import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.HexFormat;
import java.util.stream.Stream;

import static org.junit.jupiter.api.Assertions.assertArrayEquals;
import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * The content-addressed store: SHA-256 naming, media-type extensions, and the
 * dedup guarantee (same bytes, same name, one file).
 */
class ImageStoreTest {

    @TempDir
    Path dir;

    private static String sha256Of(byte[] bytes) throws NoSuchAlgorithmException {
        return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(bytes));
    }

    @Test
    void putWritesTheBytesUnderTheirShaWithTheRightExtension() throws Exception {
        byte[] bytes = "not really a png".getBytes(StandardCharsets.UTF_8);
        String expectedSha = sha256Of(bytes);

        ImageStore.Ref ref = new ImageStore(dir).put(bytes, "image/png");

        assertEquals(expectedSha, ref.sha256());
        assertEquals("images/" + expectedSha + ".png", ref.blobPath(),
                "the blobPath is relative to ~/.spectro, as stored in the event");
        assertEquals(dir.resolve(expectedSha + ".png"), ref.file());
        assertArrayEquals(bytes, Files.readAllBytes(ref.file()));
    }

    @Test
    void identicalBytesTwiceYieldOneFileAndTheSameRef() throws IOException {
        byte[] bytes = "same picture".getBytes(StandardCharsets.UTF_8);
        ImageStore store = new ImageStore(dir);

        ImageStore.Ref first = store.put(bytes, "image/png");
        ImageStore.Ref second = store.put(bytes, "image/png");

        assertEquals(first, second, "content addressing makes the second put a no-op");
        try (Stream<Path> entries = Files.list(dir)) {
            assertEquals(1, entries.count(), "same bytes, same name, one file");
        }
    }

    @Test
    void mediaTypesMapToTheirConventionalExtensions() {
        ImageStore store = new ImageStore(dir);

        assertTrue(store.put(new byte[] {1}, "image/jpeg").blobPath().endsWith(".jpg"));
        assertTrue(store.put(new byte[] {2}, "image/webp").blobPath().endsWith(".webp"));
        assertTrue(store.put(new byte[] {3}, "application/octet-stream").blobPath().endsWith(".bin"),
                "unknown media types fall back to .bin");
    }

    @Test
    void everyServableTypeStoresUnderARealExtensionAndTheRestFallsToTheUnreadableBin() {
        ImageStore store = new ImageStore(dir);

        for (String mediaType : ImageStore.servableMediaTypes()) {
            String blobPath = store.put(mediaType.getBytes(StandardCharsets.UTF_8), mediaType)
                    .blobPath();
            assertFalse(blobPath.endsWith(".bin"),
                    mediaType + " is declared servable and must not land as .bin: " + blobPath);
        }

        // The other half of the promise, and the reason an untrusted media type is
        // checked BEFORE the put: what the store cannot name, no endpoint serves.
        assertNull(ImageStore.servableMediaType("image/gif"));
        assertTrue(store.put(new byte[] {4}, "image/gif").blobPath().endsWith(".bin"),
                "a type outside the set still falls back — the caller must not get there");
    }

    @Test
    void aMediaTypeIsCanonicalizedBeforeItIsJudged() {
        // RFC 2045: the type is case-insensitive and may carry parameters. A correct
        // server writing IMAGE/PNG must not have its picture filed as unreadable .bin.
        assertEquals("image/png", ImageStore.servableMediaType("IMAGE/PNG"));
        assertEquals("image/webp", ImageStore.servableMediaType("image/WebP; charset=binary"));
        assertEquals("image/jpeg", ImageStore.servableMediaType("  image/jpeg  "));
        assertNull(ImageStore.servableMediaType(null));
        assertNull(ImageStore.servableMediaType(""));
        assertTrue(new ImageStore(dir).put(new byte[] {5}, "IMAGE/PNG").blobPath().endsWith(".png"),
                "the store files it under the canonical extension, not .bin");
    }
}
