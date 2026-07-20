package dev.spectroscope.core.image;

import java.io.IOException;
import java.io.UncheckedIOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.HexFormat;

/**
 * Content-addressed image store: bytes land under {@code <dir>/<sha256>.<ext>},
 * so identical images share one file and events can carry a small, stable
 * reference instead of the payload. The default location is
 * {@code ~/.spectro/images}; the {@link Ref#blobPath()} in the
 * {@code image_generated} event is relative to {@code ~/.spectro}.
 */
public final class ImageStore {

    private final Path dir;

    /**
     * Points the store at its blob directory — nothing is created until the first put.
     *
     * @param dir directory the blobs land in
     */
    public ImageStore(Path dir) {
        this.dir = dir;
    }

    /** The store every face shares: {@code ~/.spectro/images} (created lazily on first put). */
    public static ImageStore inUserHome() {
        return new ImageStore(Path.of(System.getProperty("user.home"), ".spectro", "images"));
    }

    /**
     * Writes the bytes under their SHA-256 name — unless that file already exists:
     * same bytes, same name, one file. Directories are created lazily here, not in
     * the constructor.
     *
     * @param bytes     raw image payload to persist
     * @param mediaType MIME type deciding the file extension
     * @return the event-ready reference: relative blob path, content hash, absolute file
     */
    public Ref put(byte[] bytes, String mediaType) {
        String sha256 = sha256Hex(bytes);
        String fileName = sha256 + "." + extensionFor(mediaType);
        try {
            Files.createDirectories(dir);
            Path file = dir.resolve(fileName);
            if (!Files.exists(file)) {
                Files.write(file, bytes);
            }
            return new Ref("images/" + fileName, sha256, file);
        } catch (IOException failure) {
            throw new UncheckedIOException("could not store image " + fileName, failure);
        }
    }

    /**
     * Lowercase hex SHA-256 of the payload — the content address. SHA-256 is
     * JCA-mandated, so the checked exception can never actually happen.
     *
     * @param bytes payload to hash
     * @return 64 lowercase hex characters
     */
    private static String sha256Hex(byte[] bytes) {
        try {
            return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(bytes));
        } catch (NoSuchAlgorithmException impossible) {
            throw new IllegalStateException("SHA-256 is mandated by the JCA spec", impossible);
        }
    }

    /**
     * Maps a media type to its file extension; anything unrecognized stores as {@code .bin}.
     *
     * @param mediaType MIME type as reported by the provider
     * @return the extension, without the dot
     */
    private static String extensionFor(String mediaType) {
        return switch (mediaType) {
            case "image/png" -> "png";
            case "image/jpeg" -> "jpg";
            case "image/webp" -> "webp";
            default -> "bin";
        };
    }

    /**
     * What a put returns: the event-ready path (relative to {@code ~/.spectro}), hash, and file.
     *
     * @param blobPath path relative to {@code ~/.spectro}, as carried by {@code image_generated}
     * @param sha256   content hash of the bytes — doubles as the file name stem
     * @param file     absolute path of the stored blob
     */
    public record Ref(String blobPath, String sha256, Path file) {}
}
