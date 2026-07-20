package dev.spectroscope.core.image;

import java.awt.Graphics2D;
import java.awt.RenderingHints;
import java.awt.image.BufferedImage;
import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.io.IOException;

/**
 * The shared image-downscale policy behind the providers' 5 MB per-image wire
 * limit — extracted from view_image (file_upload) so the composer attachment
 * path applies the SAME ladder instead of rejecting big iPhone photos.
 *
 * <p>Contract of {@link #fitWireLimit}: bytes under the limit pass through
 * UNTOUCHED (no decode, no re-encode — small images stay byte-identical);
 * an oversized image walks the long-edge ladder (2576 → 1568 → 1024 px,
 * photos re-encode as JPEG, transparency keeps PNG while it fits, flatten as
 * the last resort); anything oversized that is not a decodable image refuses
 * with a READABLE IOException.</p>
 */
public final class ImageDownscaler {

    /** The providers' per-image wire limit (Anthropic rejects larger images). */
    public static final long WIRE_IMAGE_LIMIT_BYTES = 5L * 1024 * 1024;

    /** Downscale ladder: long-edge targets tried until the re-encode fits the
     *  wire. 2576 is the high-res vision maximum of the current Anthropic
     *  generation (Opus 4.7+); 1568 the classic normalization edge — anything
     *  larger is downscaled by the API anyway, so sending more wastes bytes. */
    private static final int[] DOWNSCALE_LONG_EDGES_PX = {2576, 1568, 1024};

    /** JPEG quality for downscaled photos — visually clean, small on the wire. */
    private static final float DOWNSCALE_JPEG_QUALITY = 0.85f;

    /** Static utility — never instantiated. */
    private ImageDownscaler() {}

    /**
     * One wire-ready encoding.
     *
     * @param mediaType  the effective type (the original's, or image/jpeg / image/png after a downscale)
     * @param bytes      the wire-ready bytes
     * @param width      the result width in pixels; 0 when the bytes passed through undecoded
     * @param height     the result height in pixels; 0 when the bytes passed through undecoded
     * @param downscaled true when the ladder ran — callers name it honestly
     */
    public record Result(String mediaType, byte[] bytes, int width, int height, boolean downscaled) {}

    /**
     * Fits a payload under the wire limit — the ONE policy both view_image and
     * the composer attachment path apply.
     *
     * @param bytes     the raw payload
     * @param mediaType the payload's IANA type; only {@code image/*} can be downscaled
     * @return the untouched bytes when small, else the first ladder encoding that fits
     * @throws IOException oversized non-images, undecodable images, and images
     *                     nothing in the ladder can shrink under the limit
     */
    public static Result fitWireLimit(byte[] bytes, String mediaType) throws IOException {
        if (bytes.length <= WIRE_IMAGE_LIMIT_BYTES) {
            return new Result(mediaType, bytes, 0, 0, false);
        }
        if (mediaType == null || !mediaType.startsWith("image/")) {
            throw new IOException("payload too large (" + bytes.length
                    + " bytes) and not an image — the wire limit is 5 MB per attachment.");
        }
        return downscaleToWireLimit(bytes, mediaType);
    }

    /**
     * Walks the ladder for an oversized image — see the class contract.
     *
     * @param source    the oversized image bytes
     * @param mediaType the source type, used only for readable error messages
     * @return the first encoding that fits the wire
     * @throws IOException when the image cannot be decoded or nothing fits
     */
    public static Result downscaleToWireLimit(byte[] source, String mediaType) throws IOException {
        BufferedImage image = javax.imageio.ImageIO.read(new ByteArrayInputStream(source));
        if (image == null) {
            throw new IOException("cannot decode this " + mediaType + " for downscaling"
                    + ("image/webp".equals(mediaType)
                            ? " (webp over 5 MB is not downscalable here — convert to jpg first)"
                            : "") + ".");
        }
        boolean alpha = image.getColorModel().hasAlpha();
        for (int longEdge : DOWNSCALE_LONG_EDGES_PX) {
            BufferedImage scaled = scaleToLongEdge(image, longEdge, alpha);
            byte[] encoded = alpha ? encodePng(scaled) : encodeJpeg(scaled);
            if (encoded.length <= WIRE_IMAGE_LIMIT_BYTES) {
                return new Result(alpha ? "image/png" : "image/jpeg", encoded,
                        scaled.getWidth(), scaled.getHeight(), true);
            }
        }
        // Last resort: flatten transparency to JPEG at the smallest ladder step.
        BufferedImage flattened = scaleToLongEdge(image,
                DOWNSCALE_LONG_EDGES_PX[DOWNSCALE_LONG_EDGES_PX.length - 1], false);
        byte[] encoded = encodeJpeg(flattened);
        if (encoded.length > WIRE_IMAGE_LIMIT_BYTES) {
            throw new IOException("cannot downscale this image under the 5 MB limit.");
        }
        return new Result("image/jpeg", encoded, flattened.getWidth(), flattened.getHeight(), true);
    }

    /**
     * Scales an image so its long edge is at most the target (never upscales).
     *
     * @param source    the decoded source
     * @param longEdge  the target long edge in pixels
     * @param keepAlpha true to keep the alpha channel (PNG path)
     * @return the scaled image, bilinear-filtered
     */
    private static BufferedImage scaleToLongEdge(BufferedImage source, int longEdge, boolean keepAlpha) {
        int sourceLong = Math.max(source.getWidth(), source.getHeight());
        double factor = Math.min(1.0, longEdge / (double) sourceLong);
        int width = Math.max(1, (int) Math.round(source.getWidth() * factor));
        int height = Math.max(1, (int) Math.round(source.getHeight() * factor));
        BufferedImage target = new BufferedImage(width, height,
                keepAlpha ? BufferedImage.TYPE_INT_ARGB : BufferedImage.TYPE_INT_RGB);
        Graphics2D graphics = target.createGraphics();
        graphics.setRenderingHint(RenderingHints.KEY_INTERPOLATION,
                RenderingHints.VALUE_INTERPOLATION_BILINEAR);
        graphics.drawImage(source, 0, 0, width, height, null);
        graphics.dispose();
        return target;
    }

    /**
     * Encodes a JPEG at the downscale quality.
     *
     * @param image the RGB image to encode
     * @return the JPEG bytes
     * @throws IOException when no JPEG writer is available
     */
    private static byte[] encodeJpeg(BufferedImage image) throws IOException {
        var writers = javax.imageio.ImageIO.getImageWritersByFormatName("jpeg");
        if (!writers.hasNext()) {
            throw new IOException("no JPEG encoder available.");
        }
        javax.imageio.ImageWriter writer = writers.next();
        javax.imageio.ImageWriteParam params = writer.getDefaultWriteParam();
        params.setCompressionMode(javax.imageio.ImageWriteParam.MODE_EXPLICIT);
        params.setCompressionQuality(DOWNSCALE_JPEG_QUALITY);
        var buffer = new ByteArrayOutputStream();
        try (var output = javax.imageio.ImageIO.createImageOutputStream(buffer)) {
            writer.setOutput(output);
            writer.write(null, new javax.imageio.IIOImage(image, null, null), params);
        } finally {
            writer.dispose();
        }
        return buffer.toByteArray();
    }

    /**
     * Encodes a PNG (keeps transparency).
     *
     * @param image the ARGB image to encode
     * @return the PNG bytes
     * @throws IOException when encoding fails
     */
    private static byte[] encodePng(BufferedImage image) throws IOException {
        var buffer = new ByteArrayOutputStream();
        javax.imageio.ImageIO.write(image, "png", buffer);
        return buffer.toByteArray();
    }
}
