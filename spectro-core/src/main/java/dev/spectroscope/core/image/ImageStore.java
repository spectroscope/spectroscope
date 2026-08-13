package dev.spectroscope.core.image;

import java.io.IOException;
import java.io.UncheckedIOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.HexFormat;
import java.util.List;
import java.util.Locale;
import java.util.Map;

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
     * The media types this store can write under a name the session is able to
     * serve back: {@code GET /api/images/{file}} accepts 64 hex characters plus one
     * of these extensions, and so do the copy-to-workspace endpoint and the web's
     * own stored-image guard. Anything else lands as {@code .bin}, which no
     * endpoint serves — a blob nothing can read.
     *
     * <p>That fallback is fine for a caller that controls its own media type
     * ({@code generate_image} does), and a trap for one that does not: an MCP
     * server names the type of the image it returns, so {@code McpTool} asks
     * {@link #servableMediaType} first and refuses rather than storing a picture
     * the session could never show (card 198, AC 5).
     */
    private static final Map<String, String> SERVABLE_EXTENSIONS =
            Map.of("image/png", "png", "image/jpeg", "jpg", "image/webp", "webp");

    /**
     * The media types the store-and-serve chain carries end to end, in a stable
     * order — the set {@link #servableMediaType} accepts, for callers that need to
     * name it in a message or walk it in a test.
     *
     * @return the servable media types, sorted
     */
    public static List<String> servableMediaTypes() {
        return SERVABLE_EXTENSIONS.keySet().stream().sorted().toList();
    }

    /**
     * Canonicalizes an <b>untrusted</b> media type, or refuses it. Media types are
     * case-insensitive and may carry parameters (RFC 2045), so {@code IMAGE/PNG} and
     * {@code image/png; charset=binary} are the same type as {@code image/png} and
     * are answered with that one spelling — the value a caller should then use for
     * the store, the event and the provider wire alike.
     *
     * @param mediaType the type as some other party named it, possibly null
     * @return the canonical type, or {@code null} when this chain cannot carry it
     */
    public static String servableMediaType(String mediaType) {
        if (mediaType == null) {
            return null;
        }
        String canonical = mediaType.split(";", 2)[0].strip().toLowerCase(Locale.ROOT);
        return SERVABLE_EXTENSIONS.containsKey(canonical) ? canonical : null;
    }

    /**
     * Maps a media type to its file extension; anything unrecognized stores as {@code .bin}.
     *
     * @param mediaType MIME type as reported by the provider
     * @return the extension, without the dot
     */
    private static String extensionFor(String mediaType) {
        String canonical = servableMediaType(mediaType);
        return canonical == null ? "bin" : SERVABLE_EXTENSIONS.get(canonical);
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
