package dev.spectroscope.core.playbook;

import java.io.IOException;
import java.nio.ByteBuffer;
import java.nio.channels.SeekableByteChannel;
import java.nio.file.Files;
import java.nio.file.LinkOption;
import java.nio.file.StandardOpenOption;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.HexFormat;
import java.util.List;
import java.util.Set;

import static java.nio.charset.StandardCharsets.UTF_8;

/**
 * The one content hash of playbooks: SHA-256, lowercase hex.
 *
 * <p>A tree entry is the relative path in UTF-8, one zero byte, the length in decimal as UTF-8, one
 * zero byte and the file bytes; all entries of a walk, in the walk's {@code files} order, feed one
 * digest. This is the entry format of P3's pinned playbook hash
 * ({@code konzept/playbook/P3-run-on-engine-spec.md}, Confirmation and hash), so P3 reuses this
 * class instead of a second function, and P3's pin and P6's item hash of the same skill folder agree
 * byte for byte. P3 writes its value with a {@code sha256:} prefix; this class returns the bare hex.
 */
public final class ContentHash {

    private ContentHash() {
    }

    /** The tree hash of every file of the walk. A walk with a refusal is an {@link IllegalArgumentException}. */
    public static String tree(SafeWalk.Walk walk) throws IOException {
        return tree(walk, Set.of());
    }

    /**
     * The tree hash of the walk's files minus {@code skip}, relative paths as the walk lists them
     * (the generated files of an installed copy, for example {@code LICENSE}).
     */
    public static String tree(SafeWalk.Walk walk, Set<String> skip) throws IOException {
        if (!walk.refused().isEmpty()) {
            throw new IllegalArgumentException("a walk with refusals is not hashed: " + walk.refused());
        }
        MessageDigest d = sha256();
        for (String rel : walk.files()) {
            if (skip.contains(rel)) {
                continue;
            }
            byte[] body = read(walk, rel);
            d.update(rel.getBytes(UTF_8));
            d.update((byte) 0);
            d.update(Integer.toString(body.length).getBytes(UTF_8));
            d.update((byte) 0);
            d.update(body);
        }
        return HexFormat.of().formatHex(d.digest());
    }

    /** The hash of one hook entry: event, matcher, command, timeoutSeconds, each followed by a zero byte; null is empty. */
    public static String hook(String event, String matcher, String command, Integer timeoutSeconds) {
        MessageDigest d = sha256();
        for (String field : new String[] {event, matcher, command, timeoutSeconds == null ? null : timeoutSeconds.toString()}) {
            if (field != null) {
                d.update(field.getBytes(UTF_8));
            }
            d.update((byte) 0);
        }
        return HexFormat.of().formatHex(d.digest());
    }

    /** The contents hash: the lines {@code "<kind> <name> <sha256>"}, sorted, each followed by a newline. */
    public static String contents(List<String> lines) {
        List<String> sorted = new ArrayList<>(lines);
        sorted.sort((a, b) -> Arrays.compareUnsigned(a.getBytes(UTF_8), b.getBytes(UTF_8)));
        MessageDigest d = sha256();
        for (String line : sorted) {
            d.update(line.getBytes(UTF_8));
            d.update((byte) '\n');
        }
        return HexFormat.of().formatHex(d.digest());
    }

    private static byte[] read(SafeWalk.Walk walk, String rel) throws IOException {
        try (SeekableByteChannel ch = Files.newByteChannel(walk.root().resolve(rel),
                Set.of(StandardOpenOption.READ, LinkOption.NOFOLLOW_LINKS))) {
            long size = ch.size();
            if (size > Integer.MAX_VALUE) {
                throw new IOException(rel + ": too large to hash");
            }
            ByteBuffer buf = ByteBuffer.allocate((int) size);
            while (buf.hasRemaining() && ch.read(buf) >= 0) {
                // read until full or end of file
            }
            if (buf.hasRemaining() || ch.read(ByteBuffer.allocate(1)) >= 0) {
                throw new IOException(rel + ": changed while it was hashed");
            }
            return buf.array();
        }
    }

    private static MessageDigest sha256() {
        try {
            return MessageDigest.getInstance("SHA-256");
        } catch (NoSuchAlgorithmException e) {
            throw new IllegalStateException("SHA-256 is missing from this runtime", e);
        }
    }
}
