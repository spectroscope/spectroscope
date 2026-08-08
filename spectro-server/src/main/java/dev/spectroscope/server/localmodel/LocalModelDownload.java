package dev.spectroscope.server.localmodel;

import java.io.InputStream;
import java.io.OutputStream;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import java.security.DigestOutputStream;
import java.security.MessageDigest;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.concurrent.atomic.AtomicLong;
import java.util.concurrent.atomic.AtomicReference;

/**
 * Downloads the bundled model to {@code ~/.spectro/models}, verifies its pinned
 * sha256, and moves it into place ATOMICALLY — a failed or corrupt download
 * never leaves a half file that looks ready. The HTTP fetch is a seam
 * ({@link Fetcher}) so the flow is tested without the network or a 2 GB file.
 *
 * <p>The download runs on a virtual thread; {@link #status()} is polled by the
 * download modal for progress. State: {@code absent → downloading → ready} or
 * {@code failed}.</p>
 */
public final class LocalModelDownload {

    /** The HTTP leg as a seam — production opens the pinned URL, tests inject bytes. */
    public interface Fetcher {
        InputStream open(String url) throws Exception;
    }

    private final Path modelsDir;
    private final String fileName;
    private final String sha256;
    private final long totalBytes;
    private final Fetcher fetcher;
    private final String url;

    private final AtomicReference<String> state = new AtomicReference<>("absent");
    private final AtomicLong bytes = new AtomicLong(0);
    private final AtomicReference<String> error = new AtomicReference<>(null);

    /** Seam constructor for tests — the url is unused (the fetcher ignores it). */
    public LocalModelDownload(Path modelsDir, String fileName, String sha256, long totalBytes, Fetcher fetcher) {
        this(modelsDir, fileName, sha256, totalBytes, fetcher, "test://" + fileName);
    }

    /** Full constructor. */
    public LocalModelDownload(Path modelsDir, String fileName, String sha256, long totalBytes,
            Fetcher fetcher, String url) {
        this.modelsDir = modelsDir;
        this.fileName = fileName;
        this.sha256 = sha256;
        this.totalBytes = totalBytes;
        this.fetcher = fetcher;
        this.url = url;
        if (Files.isRegularFile(modelsDir.resolve(fileName))) {
            state.set("ready");
        }
    }

    /** Kick off the download on a virtual thread if not already running/ready. Idempotent. */
    public synchronized void start() {
        if (state.get().equals("downloading") || state.get().equals("ready")) {
            return;
        }
        state.set("downloading");
        bytes.set(0);
        error.set(null);
        Thread.startVirtualThread(this::run);
    }

    private void run() {
        Path tmp = modelsDir.resolve(fileName + ".part");
        try {
            Files.createDirectories(modelsDir);
            MessageDigest digest = MessageDigest.getInstance("SHA-256");
            try (InputStream in = fetcher.open(url);
                    OutputStream fileOut = Files.newOutputStream(tmp);
                    DigestOutputStream out = new DigestOutputStream(fileOut, digest)) {
                byte[] buf = new byte[1 << 16];
                int n;
                while ((n = in.read(buf)) != -1) {
                    out.write(buf, 0, n);
                    bytes.addAndGet(n);
                }
            }
            String got = hex(digest.digest());
            if (!got.equalsIgnoreCase(sha256)) {
                throw new IllegalStateException("sha256 mismatch: expected " + sha256 + " got " + got);
            }
            Files.move(tmp, modelsDir.resolve(fileName),
                    StandardCopyOption.ATOMIC_MOVE, StandardCopyOption.REPLACE_EXISTING);
            state.set("ready");
        } catch (Exception failed) {
            error.set(String.valueOf(failed.getMessage()));
            state.set("failed");
            try {
                Files.deleteIfExists(tmp);
            } catch (Exception ignore) {
                // best-effort cleanup of the partial file
            }
        }
    }

    /** The modal polls this: state, bytes so far, the pinned total, and any error. */
    public Map<String, Object> status() {
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("state", state.get());
        out.put("bytes", bytes.get());
        out.put("total", totalBytes);
        if (error.get() != null) {
            out.put("error", error.get());
        }
        return out;
    }

    private static String hex(byte[] b) {
        StringBuilder s = new StringBuilder();
        for (byte x : b) {
            s.append(String.format("%02x", x));
        }
        return s.toString();
    }
}
