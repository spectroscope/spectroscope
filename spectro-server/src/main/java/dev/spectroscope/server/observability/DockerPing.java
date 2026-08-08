package dev.spectroscope.server.observability;

import java.io.File;
import java.io.IOException;
import java.net.StandardProtocolFamily;
import java.net.UnixDomainSocketAddress;
import java.nio.ByteBuffer;
import java.nio.channels.SocketChannel;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;
import java.util.Locale;
import java.util.concurrent.ExecutionException;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.TimeoutException;
import java.util.concurrent.atomic.AtomicReference;

/**
 * Reads whether a Docker daemon is there, and nothing else. No process is
 * spawned, no container is touched, no command is run: the presence half is a
 * {@link Files#isExecutable} walk and the liveness half is a single
 * {@code GET /_ping} written to the daemon's unix socket by hand.
 *
 * <p>Why by hand rather than {@code docker info}: shelling out is a process
 * spawn, and a spawn is the one thing this surface promises never to do. The
 * socket read is stdlib since Java 16 ({@link StandardProtocolFamily#UNIX}) and
 * answers the same question in one round trip.
 *
 * <p>Everything here that decides something is a pure function on a string, so
 * it is pinned by {@code DockerPingTest} without a daemon present.
 */
final class DockerPing {

    /** Seam: ask a socket path whether a Docker daemon answers there. */
    @FunctionalInterface
    interface Probe {
        /**
         * @param socketPath the unix socket to ask
         * @return true when the daemon answered {@code 200}
         * @throws Exception when the socket is absent, refused or forbidden
         */
        boolean ping(String socketPath) throws Exception;
    }

    /** How long the whole socket round trip may take before we call it dead. */
    static final long PROBE_BUDGET_MS = 1500L;

    /** System-wide compose plugin locations. Not home dependent. */
    private static final List<String> SYSTEM_COMPOSE_DIRS = List.of(
            "/usr/local/lib/docker/cli-plugins",
            "/usr/libexec/docker/cli-plugins",
            "/opt/homebrew/lib/docker/cli-plugins");

    /**
     * Where a {@code docker} executable lives when it is not on our
     * {@code PATH}. Docker Desktop symlinks into the first, Homebrew into the
     * second. Not home dependent.
     */
    private static final List<String> SYSTEM_BINARY_DIRS = List.of(
            "/usr/local/bin",
            "/opt/homebrew/bin",
            "/usr/bin");

    private DockerPing() {}

    /**
     * Every home worth searching for someone else's tooling, in order.
     *
     * <p>{@code user.home} alone is not enough. The house recipe for a clean
     * first-run test starts the server with {@code -Duser.home=/tmp/...}, and
     * the desktop shell can do the same; the Docker CLI meanwhile installs
     * under the real {@code $HOME}. Reading only the JVM property therefore
     * reports "no compose plugin" on a machine that plainly has one, which is
     * the same false negative as probing {@code PATH}, just relocated. This was
     * measured, not guessed: an isolated-home server answered {@code
     * compose:false} on a host whose plugin was installed and working.
     *
     * @param envHome  the {@code HOME} environment variable, may be null
     * @param propHome the {@code user.home} property, may be null
     * @return the distinct, non-blank homes to search
     */
    static List<String> homesToSearch(String envHome, String propHome) {
        List<String> homes = new java.util.ArrayList<>(2);
        for (String home : List.of(envHome == null ? "" : envHome, propHome == null ? "" : propHome)) {
            String trimmed = home.strip();
            if (!trimmed.isEmpty() && !homes.contains(trimmed)) {
                homes.add(trimmed);
            }
        }
        return List.copyOf(homes);
    }

    /**
     * Where a {@code docker-compose} CLI plugin may live.
     *
     * <p>The plugin is not on {@code PATH}: probing {@code PATH} for
     * {@code docker-compose} reports false on a perfectly good Docker Desktop
     * install, which is the false negative this list exists to avoid.
     *
     * @param envHome  the {@code HOME} environment variable, may be null
     * @param propHome the {@code user.home} property, may be null
     * @return the directories to check, home-local first
     */
    static List<String> composePluginDirs(String envHome, String propHome) {
        List<String> dirs = new java.util.ArrayList<>();
        for (String home : homesToSearch(envHome, propHome)) {
            dirs.add(home + "/.docker/cli-plugins");
        }
        dirs.addAll(SYSTEM_COMPOSE_DIRS);
        return List.copyOf(dirs);
    }

    /**
     * Where a Docker daemon socket may live.
     *
     * @param envHome  the {@code HOME} environment variable, may be null
     * @param propHome the {@code user.home} property, may be null
     * @return the sockets to try, the system one first
     */
    static List<String> socketCandidates(String envHome, String propHome) {
        List<String> sockets = new java.util.ArrayList<>();
        sockets.add("/var/run/docker.sock");
        for (String home : homesToSearch(envHome, propHome)) {
            sockets.add(home + "/.docker/run/docker.sock");
        }
        return List.copyOf(sockets);
    }

    /**
     * Whether a raw daemon response is a {@code 200}.
     *
     * @param response the first bytes read off the socket, decoded as ASCII
     * @return true only for an HTTP status line carrying 200; never throws
     */
    static boolean answeredOk(String response) {
        if (response == null) {
            return false;
        }
        int end = response.indexOf('\n');
        String statusLine = (end < 0 ? response : response.substring(0, end)).trim();
        if (!statusLine.startsWith("HTTP/")) {
            return false;
        }
        String[] parts = statusLine.split("\\s+");
        return parts.length >= 2 && "200".equals(parts[1]);
    }

    /**
     * Whether {@code DOCKER_HOST} names someone else's machine.
     *
     * @param dockerHost the raw environment value, may be null
     * @return true for {@code tcp://} and {@code ssh://}
     */
    static boolean isRemote(String dockerHost) {
        String scheme = schemeOf(dockerHost);
        return "tcp".equals(scheme) || "ssh".equals(scheme);
    }

    /**
     * The scheme of a {@code DOCKER_HOST}, and only the scheme. The value can
     * carry a user and a host name; neither is ours to hand back.
     *
     * @param dockerHost the raw environment value, may be null
     * @return the lowercase scheme, or the empty string when there is none
     */
    static String schemeOf(String dockerHost) {
        if (dockerHost == null) {
            return "";
        }
        int marker = dockerHost.indexOf("://");
        return marker <= 0 ? "" : dockerHost.substring(0, marker).trim().toLowerCase(Locale.ROOT);
    }

    /**
     * The socket path inside a {@code DOCKER_HOST} value.
     *
     * @param dockerHost the raw environment value, may be null
     * @return the bare path, or null when the value is absent or blank
     */
    static String socketPathIn(String dockerHost) {
        if (dockerHost == null || dockerHost.isBlank()) {
            return null;
        }
        String trimmed = dockerHost.trim();
        return trimmed.startsWith("unix://") ? trimmed.substring("unix://".length()) : trimmed;
    }

    /**
     * The socket to ask when nothing is configured. On macOS the first entry is
     * a symlink into the second; connect resolves it, so the order only decides
     * which name appears in a failure message.
     *
     * @return the first existing default socket, or the first candidate when
     *         none exists, so the failure message names something real
     */
    static String defaultSocketPath() {
        List<String> candidates =
                socketCandidates(System.getenv("HOME"), System.getProperty("user.home"));
        for (String candidate : candidates) {
            try {
                if (Files.exists(Path.of(candidate))) {
                    return candidate;
                }
            } catch (RuntimeException malformed) {
                // a junk candidate is not an answer either way, keep looking
            }
        }
        return candidates.get(0);
    }

    /**
     * Every directory worth searching for the {@code docker} executable, in
     * order: {@code PATH} first, then the places Docker actually installs.
     *
     * <p>{@code PATH} alone is not enough, and this is the same false negative
     * {@link #composePluginDirs} exists to avoid, one method up. It was
     * measured on 2026-08-02 rather than reasoned about: a macOS app launched
     * from the Finder inherits the launchd environment, which on a machine with
     * no user override is {@code /usr/bin:/bin:/usr/sbin:/sbin}, and
     * {@code spectro-desktop} spawns the JVM with no environment of its own.
     * Docker Desktop meanwhile installs its binary at
     * {@code /usr/local/bin/docker}. The shipped 0.5.0 jar, started with
     * exactly that PATH, therefore answered {@code docker:"absent"} on a host
     * whose daemon was up, and Settings offered that operator the download.
     *
     * @param path     the {@code PATH} value, may be null
     * @param envHome  the {@code HOME} environment variable, may be null
     * @param propHome the {@code user.home} property, may be null
     * @return the distinct, non-blank directories to check
     */
    static List<String> binaryDirs(String path, String envHome, String propHome) {
        List<String> dirs = new java.util.ArrayList<>();
        for (String entry : (path == null ? "" : path).split(File.pathSeparator)) {
            String trimmed = entry.strip();
            if (!trimmed.isEmpty() && !dirs.contains(trimmed)) {
                dirs.add(trimmed);
            }
        }
        List<String> wellKnown = new java.util.ArrayList<>(SYSTEM_BINARY_DIRS);
        for (String home : homesToSearch(envHome, propHome)) {
            wellKnown.add(home + "/.docker/bin");
        }
        for (String dir : wellKnown) {
            if (!dirs.contains(dir)) {
                dirs.add(dir);
            }
        }
        return List.copyOf(dirs);
    }

    /**
     * Whether a {@code docker} executable exists at all. Presence only, which is
     * precisely why it is not the whole answer: an installed binary with a dead
     * daemon is the case this card exists to report honestly. The reverse is
     * true too, which is why the caller no longer stops here on a miss: an
     * absent binary is not evidence of an absent daemon.
     *
     * @return true when {@code docker} is executable in one of
     *         {@link #binaryDirs}
     */
    static boolean binaryInstalled() {
        for (String dir : binaryDirs(
                System.getenv("PATH"), System.getenv("HOME"), System.getProperty("user.home"))) {
            try {
                if (Files.isExecutable(Path.of(dir, "docker"))) {
                    return true;
                }
            } catch (RuntimeException malformedEntry) {
                // a junk PATH entry is not an answer either way, keep looking
            }
        }
        return false;
    }

    /**
     * Whether the compose v2 CLI plugin is installed.
     *
     * @return true when a {@code docker-compose} plugin file exists in one of
     *         the known plugin directories
     */
    static boolean composePluginPresent() {
        for (String dir : composePluginDirs(System.getenv("HOME"), System.getProperty("user.home"))) {
            try {
                if (Files.isExecutable(Path.of(dir, "docker-compose"))) {
                    return true;
                }
            } catch (RuntimeException malformed) {
                // keep looking
            }
        }
        return false;
    }

    /**
     * Ask a unix socket whether a Docker daemon answers there, inside a hard
     * budget. The blocking read runs on a virtual thread and the channel is
     * closed on timeout, because closing the channel is what unblocks the read.
     *
     * @param socketPath the socket to ask
     * @return true when the daemon answered {@code 200}
     * @throws Exception when the socket is missing, refused, forbidden or mute
     */
    static boolean pingUnixSocket(String socketPath) throws Exception {
        AtomicReference<SocketChannel> open = new AtomicReference<>();
        try (ExecutorService runner = Executors.newVirtualThreadPerTaskExecutor()) {
            Future<Boolean> answer = runner.submit(() -> {
                try (SocketChannel channel = SocketChannel.open(StandardProtocolFamily.UNIX)) {
                    open.set(channel);
                    channel.connect(UnixDomainSocketAddress.of(socketPath));
                    channel.write(StandardCharsets.US_ASCII.encode(
                            "GET /_ping HTTP/1.1\r\nHost: docker\r\nConnection: close\r\n\r\n"));
                    ByteBuffer buffer = ByteBuffer.allocate(256);
                    int read = channel.read(buffer);
                    if (read <= 0) {
                        return false;
                    }
                    buffer.flip();
                    return answeredOk(StandardCharsets.US_ASCII.decode(buffer).toString());
                }
            });
            try {
                return answer.get(PROBE_BUDGET_MS, TimeUnit.MILLISECONDS);
            } catch (ExecutionException wrapped) {
                // Measured: a missing socket arrives here as
                // "ExecutionException: java.net.SocketException: ...". Handing
                // that on would hide an AccessDeniedException inside a wrapper
                // the caller does not inspect, and a permission failure has a
                // different fix from a stopped daemon.
                Throwable cause = wrapped.getCause();
                if (cause instanceof Exception real) {
                    throw real;
                }
                throw wrapped;
            } catch (TimeoutException mute) {
                closeQuietly(open.get());
                answer.cancel(true);
                throw new IOException("no answer within " + PROBE_BUDGET_MS + " ms");
            }
        }
    }

    private static void closeQuietly(SocketChannel channel) {
        if (channel == null) {
            return;
        }
        try {
            channel.close();
        } catch (IOException alreadyGone) {
            // the read we are unblocking is the only reason to close it
        }
    }
}
