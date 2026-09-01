package dev.spectroscope.core.browser.headless;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;

import dev.spectroscope.core.config.governing.Governs;
import java.io.IOException;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Duration;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.TimeUnit;

/**
 * One headless Chrome the server spawned for one session (card 226).
 *
 * <p><b>The spawn contract.</b> Chrome is exec'd with an argv, never through a
 * shell — {@code DefaultChromeRunner}'s rule, kept even though no element here
 * is model output, because the profile path contains a session id and an id is
 * remote input. {@code --remote-debugging-port=0} lets the OS pick the port and
 * Chrome writes it to {@code DevToolsActivePort} inside the profile directory;
 * the file is polled rather than the port guessed, and the page target's
 * WebSocket URL is read from {@code /json/list} on loopback.
 *
 * <p><b>The kill contract is card 221's lesson spelled out: kill the TREE, and
 * count it twice.</b> A Chrome is never one process — a browser, a GPU process,
 * a network service, a renderer per site. Killing the root and trusting the
 * rest to follow is exactly how the orphan that card cost a day was made. So
 * {@link #kill()} captures the descendants FIRST, force-kills every one of them
 * and then the root, and waits; {@link #aliveInTree()} counts survivors over
 * that captured set so a test can read zero, settle, and read zero again.
 */
public final class HeadlessChrome {

    private static final ObjectMapper JSON = new ObjectMapper();

    /** How long Chrome gets to write its DevToolsActivePort file. */
    @Governs(kind = Governs.Kind.FIXED, unit = Governs.Unit.SECONDS)
    static final Duration STARTUP_BUDGET = Duration.ofSeconds(20);

    private final Process process;
    private final Path profileDir;
    private final int port;
    private final String pageWebSocketUrl;

    /** The tree as it stood when the kill began — what the count runs over. */
    private volatile List<ProcessHandle> capturedTree = List.of();

    private HeadlessChrome(Process process, Path profileDir, int port, String pageWebSocketUrl) {
        this.process = process;
        this.profileDir = profileDir;
        this.port = port;
        this.pageWebSocketUrl = pageWebSocketUrl;
    }

    /**
     * Spawns one headless Chrome on its own profile directory and waits until
     * its page target is dialable.
     *
     * @param binary     the browser binary, from {@code BrowsePageTool.findChrome}
     * @param profileDir this session's own profile directory — card 218's
     *                   isolation boundary on this face, created here
     * @param width      the initial window width in CSS pixels
     * @param height     the initial window height
     * @return the running browser
     * @throws IOException when Chrome cannot be started or never comes up
     */
    public static HeadlessChrome spawn(Path binary, Path profileDir, int width, int height)
            throws IOException {
        Files.createDirectories(profileDir);
        List<String> argv = new ArrayList<>(List.of(
                binary.toString(),
                "--headless=new",
                "--remote-debugging-port=0",
                "--user-data-dir=" + profileDir,
                "--no-first-run",
                "--no-default-browser-check",
                "--disable-extensions",
                "--disable-background-networking",
                "--disable-sync",
                "--mute-audio",
                "--hide-scrollbars",
                "--window-size=" + width + "," + height,
                "about:blank"));
        Process process = new ProcessBuilder(argv).start();
        try {
            int port = waitForDevToolsPort(process, profileDir);
            String wsUrl = discoverPageTarget(port);
            return new HeadlessChrome(process, profileDir, port, wsUrl);
        } catch (IOException | RuntimeException failed) {
            killTree(process, List.copyOf(process.toHandle().descendants().toList()));
            throw failed;
        }
    }

    /**
     * Polls the {@code DevToolsActivePort} file Chrome writes once its debug
     * socket listens. Guessing the port instead is how a second Chrome on the
     * same machine gets driven by accident.
     */
    private static int waitForDevToolsPort(Process process, Path profileDir) throws IOException {
        Path portFile = profileDir.resolve("DevToolsActivePort");
        long deadline = System.currentTimeMillis() + STARTUP_BUDGET.toMillis();
        while (System.currentTimeMillis() < deadline) {
            if (!process.isAlive()) {
                throw new IOException("Chrome exited with code " + process.exitValue()
                        + " before DevTools was up");
            }
            if (Files.isRegularFile(portFile)) {
                List<String> lines = Files.readAllLines(portFile);
                if (!lines.isEmpty() && !lines.get(0).isBlank()) {
                    try {
                        return Integer.parseInt(lines.get(0).strip());
                    } catch (NumberFormatException halfWritten) {
                        // The file is written in two steps; ask again.
                    }
                }
            }
            try {
                Thread.sleep(100);
            } catch (InterruptedException interrupted) {
                Thread.currentThread().interrupt();
                throw new IOException("interrupted while waiting for Chrome to start");
            }
        }
        throw new IOException("Chrome did not write DevToolsActivePort within "
                + STARTUP_BUDGET.toSeconds() + " s");
    }

    /** Reads the page target's WebSocket URL from {@code /json/list} on loopback. */
    private static String discoverPageTarget(int port) throws IOException {
        HttpClient client = HttpClient.newBuilder()
                .connectTimeout(Duration.ofSeconds(5))
                .build();
        HttpRequest request = HttpRequest.newBuilder()
                .uri(URI.create("http://127.0.0.1:" + port + "/json/list"))
                .timeout(Duration.ofSeconds(5))
                .GET()
                .build();
        long deadline = System.currentTimeMillis() + 5_000;
        while (System.currentTimeMillis() < deadline) {
            try {
                HttpResponse<String> response =
                        client.send(request, HttpResponse.BodyHandlers.ofString());
                for (JsonNode target : JSON.readTree(response.body())) {
                    if ("page".equals(target.path("type").asText())) {
                        String wsUrl = target.path("webSocketDebuggerUrl").asText(null);
                        if (wsUrl != null && !wsUrl.isBlank()) {
                            return wsUrl;
                        }
                    }
                }
            } catch (IOException | InterruptedException notYet) {
                if (notYet instanceof InterruptedException) {
                    Thread.currentThread().interrupt();
                    throw new IOException("interrupted while discovering the page target");
                }
            }
            try {
                Thread.sleep(100);
            } catch (InterruptedException interrupted) {
                Thread.currentThread().interrupt();
                throw new IOException("interrupted while discovering the page target");
            }
        }
        throw new IOException("Chrome is up on port " + port + " but offered no page target");
    }

    /** @return the page target's {@code webSocketDebuggerUrl} */
    public String pageWebSocketUrl() {
        return pageWebSocketUrl;
    }

    /** @return the DevTools port Chrome chose */
    public int port() {
        return port;
    }

    /** @return the profile directory this browser writes into */
    public Path profileDir() {
        return profileDir;
    }

    /** @return whether the root process is still running */
    public boolean alive() {
        return process.isAlive();
    }

    /**
     * Kills the whole tree: descendants captured first, every one force-killed,
     * then the root, then a bounded wait.
     */
    public void kill() {
        List<ProcessHandle> tree = List.copyOf(process.toHandle().descendants().toList());
        capturedTree = tree;
        killTree(process, tree);
    }

    private static void killTree(Process root, List<ProcessHandle> descendants) {
        descendants.forEach(ProcessHandle::destroyForcibly);
        root.destroyForcibly();
        try {
            root.waitFor(5, TimeUnit.SECONDS);
        } catch (InterruptedException interrupted) {
            Thread.currentThread().interrupt();
        }
    }

    /**
     * How many processes of this browser are still alive: the root plus every
     * descendant captured when the kill began. The number a clean kill owes is
     * ZERO, and the caller reads it twice — once right after the kill and once
     * after a settle — because a dying tree can look dead and twitch.
     *
     * @return the count of survivors
     */
    public long aliveInTree() {
        long root = process.isAlive() ? 1 : 0;
        return root + capturedTree.stream().filter(ProcessHandle::isAlive).count();
    }

    /**
     * The size of the live tree right now — root plus descendants. Before a
     * kill this is the number that proves a TREE exists to kill at all.
     *
     * @return the live process count
     */
    public long treeSize() {
        long root = process.isAlive() ? 1 : 0;
        return root + process.toHandle().descendants().filter(ProcessHandle::isAlive).count();
    }
}
