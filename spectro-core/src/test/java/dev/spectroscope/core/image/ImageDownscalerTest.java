package dev.spectroscope.core.image;

import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.Timeout;

import java.awt.image.BufferedImage;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.util.Random;
import java.util.concurrent.TimeUnit;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertSame;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * The shared downscale policy (extracted from view_image for the composer
 * attachment path): under the 5 MB wire limit bytes pass through UNTOUCHED,
 * an oversized image walks the ladder until it fits, and oversized non-images
 * refuse readably instead of flooding the provider.
 */
@Timeout(value = 30, unit = TimeUnit.SECONDS)
class ImageDownscalerTest {

    /** A noise PNG bigger than the wire limit — noise defeats PNG compression. */
    private static byte[] oversizedPng() throws IOException {
        BufferedImage image = new BufferedImage(1900, 1900, BufferedImage.TYPE_INT_RGB);
        Random random = new Random(42);
        for (int x = 0; x < image.getWidth(); x++) {
            for (int y = 0; y < image.getHeight(); y++) {
                image.setRGB(x, y, random.nextInt());
            }
        }
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        javax.imageio.ImageIO.write(image, "png", out);
        return out.toByteArray();
    }

    @Test
    void smallPayloadsPassThroughUntouched() throws IOException {
        byte[] tiny = {(byte) 0x89, 'P', 'N', 'G'};

        ImageDownscaler.Result result = ImageDownscaler.fitWireLimit(tiny, "image/png");

        assertFalse(result.downscaled());
        assertSame(tiny, result.bytes(), "under the limit the bytes are untouched");
        assertEquals("image/png", result.mediaType());
    }

    @Test
    void anOversizedImageLandsUnderTheWireLimit() throws IOException {
        byte[] big = oversizedPng();
        assertTrue(big.length > ImageDownscaler.WIRE_IMAGE_LIMIT_BYTES,
                "the fixture must exceed the wire limit, got " + big.length);

        ImageDownscaler.Result result = ImageDownscaler.fitWireLimit(big, "image/png");

        assertTrue(result.downscaled());
        assertTrue(result.bytes().length <= ImageDownscaler.WIRE_IMAGE_LIMIT_BYTES,
                "fits the wire, got " + result.bytes().length);
        assertTrue(result.width() > 0 && result.height() > 0);
        assertTrue(result.mediaType().equals("image/jpeg") || result.mediaType().equals("image/png"));
    }

    @Test
    void oversizedNonImagesRefuseReadably() {
        byte[] junk = new byte[(int) ImageDownscaler.WIRE_IMAGE_LIMIT_BYTES + 1];
        junk[0] = 'x';

        IOException failure = assertThrows(IOException.class,
                () -> ImageDownscaler.fitWireLimit(junk, "application/zip"));
        assertTrue(failure.getMessage().contains("5 MB"),
                "names the limit, got: " + failure.getMessage());
    }

    @Test
    void undecodableOversizedImagesRefuseReadably() {
        byte[] junk = ("not an image " + "x".repeat((int) ImageDownscaler.WIRE_IMAGE_LIMIT_BYTES))
                .getBytes(StandardCharsets.UTF_8);

        IOException failure = assertThrows(IOException.class,
                () -> ImageDownscaler.fitWireLimit(junk, "image/png"));
        assertTrue(failure.getMessage().contains("decode"),
                "names the decode failure, got: " + failure.getMessage());
    }
}
