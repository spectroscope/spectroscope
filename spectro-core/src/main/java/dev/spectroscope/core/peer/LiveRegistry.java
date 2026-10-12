package dev.spectroscope.core.peer;

import com.fasterxml.jackson.databind.ObjectMapper;
import dev.spectroscope.core.config.governing.Governs;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import java.io.IOException;
import java.io.UncheckedIOException;
import java.net.StandardProtocolFamily;
import java.net.UnixDomainSocketAddress;
import java.nio.channels.SelectionKey;
import java.nio.channels.Selector;
import java.nio.channels.SocketChannel;
import java.nio.charset.StandardCharsets;
import java.nio.file.AtomicMoveNotSupportedException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import java.nio.file.attribute.PosixFilePermission;
import java.nio.file.attribute.PosixFilePermissions;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.ArrayList;
import java.util.HexFormat;
import java.util.List;
import java.util.Optional;
import java.util.Set;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.TimeUnit;
import java.util.regex.Pattern;
import java.util.stream.Stream;

/**
 * The registry of live processes under {@code ~/.spectro/live/} (card 502
 * criteria 1 and 2, concept section Registry).
 *
 * <p>One record per process, {@code <pid>.json}, written at start and deleted
 * at exit. A reader counts a record only when the process is alive, its start
 * instant equals {@code procStart}, its socket is the path of its pid, and the
 * socket accepts a connection within {@link PeerLimits#PROBE_TIMEOUT_MS}; every
 * other record is unlinked. The token and the socket go with the record only
 * when the process is dead or its start differs: a live process whose probe
 * failed or came late keeps both and writes its record again (see
 * {@link PeerNode}). This is
 * the answer to the objection in {@code LiveSessions}: a lock file outlives
 * the crash that wrote it, a record with a start token stops counting after
 * one. The socket probes of one listing run in parallel, so a listing costs
 * one probe timeout, not their sum; the process checks run in the same
 * parallel task as the probe of their record.</p>
 */
public final class LiveRegistry {

    private static final Logger log = LoggerFactory.getLogger(LiveRegistry.class);

    /** The longest socket path the platform binds, in bytes (sun_path on macOS is 104 with the NUL). */
    @Governs(kind = Governs.Kind.FOREIGN_CONTRACT, unit = Governs.Unit.BYTES)
    public static final int SOCKET_PATH_MAX = 103;

    private static final ObjectMapper JSON = new ObjectMapper();
    private static final Pattern STEM = Pattern.compile("[0-9]+");
    private static final Set<PosixFilePermission> PRIVATE_DIR = PosixFilePermissions.fromString("rwx------");
    private static final Set<PosixFilePermission> PRIVATE_FILE = PosixFilePermissions.fromString("rw-------");

    /** How a reader checks a record. */
    public interface Liveness {
        /**
         * @param pid a process id
         * @return the start instant of the live process, in the registry's spelling, or empty
         */
        Optional<String> startOf(long pid);

        /**
         * @param socket    the socket path
         * @param timeoutMs the most the connect may take
         * @return true when the socket accepted within the time
         */
        boolean connects(String socket, int timeoutMs);
    }

    /** The checks of a real machine: {@link ProcessHandle} and a socket connect. */
    public static final Liveness SYSTEM = new Liveness() {
        @Override
        public Optional<String> startOf(long pid) {
            return ProcessIdentity.of(pid).map(ProcessIdentity::procStart);
        }

        @Override
        public boolean connects(String socket, int timeoutMs) {
            return connectsWithin(socket, timeoutMs);
        }
    };

    /**
     * What one listing found.
     *
     * @param live     the records that passed every check, oldest registration first
     * @param unlinked the files this listing deleted
     * @param skipped  the files over the size cap, left alone
     */
    public record Listing(List<LiveRecord> live, List<String> unlinked, List<String> skipped) {
    }

    private final Path dir;
    private final Liveness liveness;

    /** @param dir the registry directory, usually {@link #defaultDir()} */
    public LiveRegistry(Path dir) {
        this(dir, SYSTEM);
    }

    /**
     * @param dir      the registry directory
     * @param liveness how records are checked
     */
    public LiveRegistry(Path dir, Liveness liveness) {
        this.dir = dir.toAbsolutePath().normalize();
        this.liveness = liveness;
    }

    /** @return {@code ~/.spectro/live} under the current {@code user.home} */
    public static Path defaultDir() {
        return Path.of(System.getProperty("user.home"), ".spectro", "live");
    }

    /** @return how this registry checks a process */
    public Liveness liveness() {
        return liveness;
    }

    /** @return the registry directory */
    public Path dir() {
        return dir;
    }

    /**
     * Where a process's socket lives: beside its record, or in a short private
     * directory under the temp folder when that path would be longer than the
     * platform binds.
     *
     * @param pid the process id
     * @return the socket path
     */
    public Path socketPathFor(long pid) {
        String widest = dir.resolve("9999999999.sock").toString();
        if (widest.getBytes(StandardCharsets.UTF_8).length <= SOCKET_PATH_MAX) {
            return dir.resolve(pid + ".sock");
        }
        String name = "spectro-live-" + hash(dir.toString());
        Path temp = Path.of(System.getProperty("java.io.tmpdir"), name).toAbsolutePath().normalize();
        if (temp.resolve("9999999999.sock").toString().getBytes(StandardCharsets.UTF_8).length <= SOCKET_PATH_MAX) {
            return temp.resolve(pid + ".sock");
        }
        return Path.of("/tmp", name).resolve(pid + ".sock");
    }

    /** @param pid the process id @return the token file beside the record */
    public Path keyPathFor(long pid) {
        return dir.resolve(pid + ".key");
    }

    /** Creates the directory, mode 0700. */
    public void ensureDir() {
        ensurePrivateDir(dir);
    }

    /**
     * Creates a directory the owner alone may enter.
     *
     * @param path the directory
     */
    static void ensurePrivateDir(Path path) {
        try {
            Files.createDirectories(path);
            Files.setPosixFilePermissions(path, PRIVATE_DIR);
        } catch (IOException failure) {
            throw new UncheckedIOException("Cannot prepare " + path, failure);
        } catch (UnsupportedOperationException noPosix) {
            // Windows has no POSIX modes; card 276 owns that platform.
        }
    }

    /**
     * Writes a record atomically, mode 0600.
     *
     * @param record the record; its pid names the file
     */
    public void write(LiveRecord record) {
        ensureDir();
        Path target = dir.resolve(record.pid() + ".json");
        Path temp = dir.resolve(record.pid() + ".json.tmp");
        try {
            Files.write(temp, JSON.writeValueAsBytes(record));
            setPrivate(temp);
            try {
                Files.move(temp, target, StandardCopyOption.REPLACE_EXISTING, StandardCopyOption.ATOMIC_MOVE);
            } catch (AtomicMoveNotSupportedException plain) {
                Files.move(temp, target, StandardCopyOption.REPLACE_EXISTING);
            }
        } catch (IOException failure) {
            throw new UncheckedIOException("Cannot write " + target, failure);
        }
    }

    /**
     * Reads one record without checking it, for a reply to a pid a socket
     * already vouched for.
     *
     * @param pid the process id
     * @return the record, or empty when there is none or it cannot be read
     */
    public Optional<LiveRecord> read(long pid) {
        Path file = dir.resolve(pid + ".json");
        try {
            if (!Files.isRegularFile(file) || Files.size(file) > PeerLimits.RECORD_MAX_BYTES) {
                return Optional.empty();
            }
            LiveRecord record = JSON.readValue(file.toFile(), LiveRecord.class);
            return record.pid() == pid ? Optional.of(record) : Optional.empty();
        } catch (IOException | RuntimeException unreadable) {
            return Optional.empty();
        }
    }

    /**
     * Deletes a process's record, its token and its socket.
     *
     * @param pid the process id
     */
    public void delete(long pid) {
        deleteQuietly(dir.resolve(pid + ".json"));
        deleteQuietly(keyPathFor(pid));
        deleteQuietly(socketPathFor(pid));
    }

    /**
     * Reads every record and keeps the live ones.
     *
     * @return what the listing found, kept and removed
     */
    public Listing list() {
        if (!Files.isDirectory(dir)) {
            return new Listing(List.of(), List.of(), List.of());
        }
        List<String> unlinked = new ArrayList<>();
        List<String> skipped = new ArrayList<>();
        List<LiveRecord> candidates = new ArrayList<>();
        List<Path> files;
        try (Stream<Path> listed = Files.list(dir)) {
            files = listed.filter(p -> p.getFileName().toString().endsWith(".json")).sorted().toList();
        } catch (IOException failure) {
            log.warn("cannot list {}: {}", dir, failure.toString());
            return new Listing(List.of(), List.of(), List.of());
        }
        for (Path file : files) {
            String fileName = file.getFileName().toString();
            String stem = fileName.substring(0, fileName.length() - ".json".length());
            if (!STEM.matcher(stem).matches()) {
                unlink(file, unlinked);
                continue;
            }
            try {
                if (Files.size(file) > PeerLimits.RECORD_MAX_BYTES) {
                    skipped.add(fileName);
                    continue;
                }
                LiveRecord record = JSON.readValue(file.toFile(), LiveRecord.class);
                if (!stem.equals(Long.toString(record.pid()))) {
                    unlink(file, unlinked);
                    continue;
                }
                candidates.add(record);
            } catch (IOException | RuntimeException unreadable) {
                unlink(file, unlinked);
            }
        }
        List<LiveRecord> live = new ArrayList<>();
        try (ExecutorService probes = Executors.newVirtualThreadPerTaskExecutor()) {
            List<Check> checks = new ArrayList<>();
            List<Future<Boolean>> answers = new ArrayList<>();
            for (LiveRecord record : candidates) {
                Check check = new Check(record);
                checks.add(check);
                answers.add(probes.submit(check::run));
            }
            long deadline = System.nanoTime() + TimeUnit.MILLISECONDS.toNanos(PeerLimits.PROBE_TIMEOUT_MS * 2L);
            for (int i = 0; i < candidates.size(); i++) {
                LiveRecord record = candidates.get(i);
                boolean accepted;
                try {
                    long left = Math.max(1, deadline - System.nanoTime());
                    accepted = answers.get(i).get(left, TimeUnit.NANOSECONDS);
                } catch (Exception late) {
                    answers.get(i).cancel(true);
                    accepted = false;
                }
                if (accepted) {
                    live.add(record);
                } else if (checks.get(i).processGone) {
                    unlinkRecord(record.pid(), dir.resolve(record.pid() + ".json"), unlinked);
                } else {
                    unlink(dir.resolve(record.pid() + ".json"), unlinked);
                }
            }
            probes.shutdownNow();
        }
        live.sort(java.util.Comparator.comparingLong(LiveRecord::startedAt).thenComparing(LiveRecord::procStart)
                .thenComparingLong(LiveRecord::pid));
        return new Listing(List.copyOf(live), List.copyOf(unlinked), List.copyOf(skipped));
    }

    /**
     * The checks of one record: alive, same start, socket at the path of its
     * pid, socket accepts. {@code processGone} is set only when the process
     * check itself said dead or reused, so a late or failed probe never costs
     * a live process its token and its socket.
     */
    private final class Check {
        private final LiveRecord record;
        private volatile boolean processGone;

        Check(LiveRecord record) {
            this.record = record;
        }

        boolean run() {
            Optional<String> start = liveness.startOf(record.pid());
            if (start.isEmpty() || !start.get().equals(record.procStart())) {
                processGone = true;
                return false;
            }
            if (record.socket() == null || !ownSocket(record)) {
                return false;
            }
            return liveness.connects(record.socket(), PeerLimits.PROBE_TIMEOUT_MS);
        }
    }

    /** True when a record's socket is the path this registry gives its pid. */
    private boolean ownSocket(LiveRecord record) {
        try {
            return Path.of(record.socket()).toAbsolutePath().normalize().equals(socketPathFor(record.pid()));
        } catch (RuntimeException badPath) {
            return false;
        }
    }

    /**
     * Connects to a socket and lets go.
     *
     * @param socket    the path
     * @param timeoutMs the most the connect may take
     * @return true when the connect succeeded in time
     */
    static boolean connectsWithin(String socket, int timeoutMs) {
        try (SocketChannel channel = SocketChannel.open(StandardProtocolFamily.UNIX)) {
            channel.configureBlocking(false);
            if (channel.connect(UnixDomainSocketAddress.of(socket))) {
                return true;
            }
            try (Selector selector = Selector.open()) {
                channel.register(selector, SelectionKey.OP_CONNECT);
                if (selector.select(timeoutMs) == 0) {
                    return false;
                }
                return channel.finishConnect();
            }
        } catch (IOException | RuntimeException refused) {
            return false;
        }
    }

    private void unlinkRecord(long pid, Path file, List<String> unlinked) {
        unlink(file, unlinked);
        deleteQuietly(keyPathFor(pid));
        deleteQuietly(socketPathFor(pid));
    }

    private static void unlink(Path file, List<String> unlinked) {
        deleteQuietly(file);
        unlinked.add(file.getFileName().toString());
    }

    private static void deleteQuietly(Path path) {
        try {
            Files.deleteIfExists(path);
        } catch (IOException ignored) {
            // A file another reader removed first is the same outcome.
        }
    }

    static void setPrivate(Path file) throws IOException {
        try {
            Files.setPosixFilePermissions(file, PRIVATE_FILE);
        } catch (UnsupportedOperationException noPosix) {
            // Windows, card 276.
        }
    }

    private static String hash(String text) {
        try {
            byte[] digest = MessageDigest.getInstance("SHA-256").digest(text.getBytes(StandardCharsets.UTF_8));
            return HexFormat.of().formatHex(digest, 0, 4);
        } catch (NoSuchAlgorithmException impossible) {
            throw new IllegalStateException(impossible);
        }
    }
}
