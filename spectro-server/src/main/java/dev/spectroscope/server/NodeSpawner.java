package dev.spectroscope.server;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Component;

import java.io.IOException;
import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.Deque;
import java.util.List;
import java.util.UUID;
import java.util.function.LongSupplier;
import java.util.regex.Pattern;

/**
 * Spawns fleet nodes on the operator's request (block 3b) — the RCE-sensitive
 * surface, gated to the teeth:
 *
 * <ul>
 *   <li><b>Opt-in, default OFF.</b> {@code SPECTRO_ALLOW_SPAWN} must be true
 *       (separate from the hub's own opt-in) — a server that merely watches a
 *       fleet never grows a process-spawning endpoint.</li>
 *   <li><b>FORCED readonly.</b> Every UI-spawned node runs {@code --permissions
 *       readonly}: it can read, but never run commands or write. So even if every
 *       other gate were bypassed, a spawned agent cannot execute code — the
 *       tool-RCE vector is closed at the source. Full-power nodes are spawned
 *       from the CLI, in the operator's own terminal (no CSRF surface there).</li>
 *   <li><b>No shell, no argv injection.</b> The command is a {@link
 *       ProcessBuilder} arg array; identifiers must match a strict allowlist that
 *       FORBIDS a leading dash (so a {@code role} of {@code "--linger"} can never
 *       become a flag), and the free-text prompt rides as {@code --prompt=<value>}
 *       (the attached form, so a prompt starting with {@code -} is a value, never
 *       an option).</li>
 *   <li><b>Rate-limited.</b> At most {@value #MAX_PER_WINDOW} spawns per
 *       {@value #WINDOW_MS} ms — one loopback caller cannot fork-bomb the host.</li>
 * </ul>
 *
 * <p>The launcher is a seam: production spawns a child JVM running the CLI off
 * the server's OWN classpath (the server depends on spectro-cli). That works when
 * the classpath is class directories (a {@code bootRun} dev server). A PACKAGED
 * server (a Spring Boot fat jar) hides the CLI class under {@code BOOT-INF}, so
 * the fallback cannot find it — set {@code SPECTRO_NODE_CMD} to a node launcher
 * executable there; the constructor warns loudly when spawning is on without it.</p>
 *
 * <p><b>Residual limits (documented, not fixed):</b> loopback is not same-user —
 * do not enable spawning on a shared/multi-user host; and a same-host reverse
 * proxy would rewrite the origin past the loopback/Host gate — do not front the
 * server with one when spawning is on.</p>
 */
@Component
public class NodeSpawner {

    private static final Logger log = LoggerFactory.getLogger(NodeSpawner.class);

    /** Identifier: letters/digits first (NEVER a dash — that would be a flag),
     *  then letters, digits, dot, dash, underscore. */
    private static final Pattern SAFE = Pattern.compile("[A-Za-z0-9][A-Za-z0-9._-]{0,63}");

    /** Spawns allowed per {@link #WINDOW_MS} — the fork-bomb ceiling. */
    static final int MAX_PER_WINDOW = 16;
    /** The rate-limit window in milliseconds. */
    static final long WINDOW_MS = 10_000;

    /** The launch seam — production starts a process, tests capture the command. */
    public interface Launcher {
        /**
         * Starts the node process from the built command (an arg array, never a
         * shell line).
         *
         * @param command the full argv: launcher, {@code node}, and its flags
         * @throws IOException when the process cannot be started
         */
        void start(List<String> command) throws IOException;
    }

    private final boolean allowSpawn;
    private final String nodeCmdOverride;
    private final FleetAggregator fleet;
    private final Launcher launcher;
    private final LongSupplier clock;
    /** False when the child-JVM fallback cannot work (a packaged fat jar with no
     *  SPECTRO_NODE_CMD): a spawn would 202 for a node that never connects, so
     *  spawning is disabled instead — {@link #allowed()} is false, endpoint 404s. */
    private final boolean launcherUsable;
    private final Deque<Long> recentSpawns = new ArrayDeque<>();

    /**
     * @param allowSpawn      {@code SPECTRO_ALLOW_SPAWN} — the spawn opt-in (default OFF)
     * @param nodeCmdOverride {@code SPECTRO_NODE_CMD} — a node launcher executable,
     *                        or blank to spawn a child JVM off the server classpath
     * @param fleet           the aggregator (its hub port is where a node connects)
     */
    @Autowired
    public NodeSpawner(@Value("${SPECTRO_ALLOW_SPAWN:false}") boolean allowSpawn,
                       @Value("${SPECTRO_NODE_CMD:}") String nodeCmdOverride,
                       FleetAggregator fleet) {
        this(allowSpawn, nodeCmdOverride, fleet,
                command -> new ProcessBuilder(command).inheritIO().start(),
                System::currentTimeMillis);
        if (allowSpawn && fleet.enabled() && !launcherUsable) {
            log.warn("SPECTRO_ALLOW_SPAWN is on but the child-JVM fallback cannot reach the CLI "
                    + "(a packaged fat jar hides it under BOOT-INF) — spawning is DISABLED. Set "
                    + "SPECTRO_NODE_CMD to a node launcher executable to enable it.");
        }
    }

    /** Visible for tests: inject a capturing launcher and a controllable clock. */
    NodeSpawner(boolean allowSpawn, String nodeCmdOverride, FleetAggregator fleet, Launcher launcher) {
        this(allowSpawn, nodeCmdOverride, fleet, launcher, System::currentTimeMillis);
    }

    NodeSpawner(boolean allowSpawn, String nodeCmdOverride, FleetAggregator fleet,
                Launcher launcher, LongSupplier clock) {
        this.allowSpawn = allowSpawn;
        this.nodeCmdOverride = nodeCmdOverride;
        this.fleet = fleet;
        this.launcher = launcher;
        this.clock = clock;
        boolean hasOverride = nodeCmdOverride != null && !nodeCmdOverride.isBlank();
        this.launcherUsable = hasOverride || !looksLikeFatJar(System.getProperty("java.class.path"));
    }

    /** @return true only when spawning is opted IN, the hub is up, AND the
     *  launcher can actually reach a node binary (never a silent false success) */
    public boolean allowed() {
        return allowSpawn && fleet.enabled() && launcherUsable;
    }

    /**
     * Whether a classpath is a packaged fat jar (a single {@code .jar} with no
     * path separator) — the child-JVM fallback's {@code -cp} cannot see the CLI
     * class there (it lives under {@code BOOT-INF}). A dev classpath (bootRun,
     * gradle) is many entries and is not one.
     *
     * @param classpath the {@code java.class.path} value
     * @return true when spawning off this classpath would fail
     */
    static boolean looksLikeFatJar(String classpath) {
        if (classpath == null || classpath.isBlank()) {
            return true; // no classpath to hand a child JVM — the fallback cannot work
        }
        return !classpath.contains(java.io.File.pathSeparator)
                && classpath.toLowerCase(java.util.Locale.ROOT).endsWith(".jar");
    }

    /**
     * Spawns one readonly fleet node that joins this server's hub.
     *
     * @param req the request body
     * @return the node's id (generated when the request gave none)
     * @throws IllegalArgumentException on a missing prompt or an unsafe identifier
     * @throws IllegalStateException    when the spawn rate limit is exceeded
     * @throws IOException              when the process cannot be started
     */
    public String spawn(SpawnRequest req) throws IOException {
        String prompt = req.prompt();
        if (prompt == null || prompt.isBlank()) {
            throw new IllegalArgumentException("prompt is required");
        }
        String context = req.context();
        if (context == null || !SAFE.matcher(context).matches()) {
            throw new IllegalArgumentException("context must match [A-Za-z0-9][A-Za-z0-9._-]{0,63}");
        }
        String role = req.role() == null || req.role().isBlank() ? "worker" : req.role();
        if (!SAFE.matcher(role).matches()) {
            throw new IllegalArgumentException("role must match [A-Za-z0-9][A-Za-z0-9._-]{0,63}");
        }
        String requestedId = req.id();
        if (requestedId != null && !requestedId.isBlank() && !SAFE.matcher(requestedId).matches()) {
            throw new IllegalArgumentException("id must match [A-Za-z0-9][A-Za-z0-9._-]{0,63}");
        }
        String nodeId = requestedId == null || requestedId.isBlank()
                ? "node-" + UUID.randomUUID().toString().substring(0, 8)
                : requestedId;

        rateLimit(); // AFTER validation (a bad request is not a spawn), BEFORE the process

        List<String> command = buildCommand(nodeId, prompt, context, role, req.linger());
        launcher.start(command);
        log.info("spawned fleet node {} (role {}, context {}) — readonly", nodeId, role, context);
        return nodeId;
    }

    /** Sliding-window rate limit — one caller cannot fork-bomb the host. */
    private synchronized void rateLimit() {
        long now = clock.getAsLong();
        while (!recentSpawns.isEmpty() && now - recentSpawns.peekFirst() > WINDOW_MS) {
            recentSpawns.pollFirst();
        }
        if (recentSpawns.size() >= MAX_PER_WINDOW) {
            throw new IllegalStateException(
                    "too many nodes spawning (max " + MAX_PER_WINDOW + " per "
                            + (WINDOW_MS / 1000) + "s) — try again shortly");
        }
        recentSpawns.addLast(now);
    }

    /**
     * Builds the node process argv. A UI-spawned node is ALWAYS readonly — the
     * permission is hard-coded here, never taken from the request. The prompt
     * uses the attached {@code --prompt=} form so it can never be re-read as a
     * flag, and identifiers are already dash-free.
     */
    private List<String> buildCommand(String nodeId, String prompt, String context,
                                      String role, boolean linger) {
        List<String> command = new ArrayList<>(launcherPrefix());
        command.add("node");
        command.add("--prompt=" + prompt); // attached — a "-"-prefixed prompt is a value, not an option
        command.add("--hub");
        command.add("127.0.0.1:" + fleet.port());
        command.add("--context");
        command.add(context);
        command.add("--role");
        command.add(role);
        command.add("--permissions");
        command.add("readonly"); // FORCED — the whole point; never from the request
        command.add("--id");
        command.add(nodeId);
        if (linger) {
            command.add("--linger");
        }
        return command;
    }

    /** The launcher prefix: a configured executable, or a child JVM running the
     *  CLI off the server's own classpath (no PATH or install layout assumed). */
    private List<String> launcherPrefix() {
        if (nodeCmdOverride != null && !nodeCmdOverride.isBlank()) {
            return List.of(nodeCmdOverride.trim());
        }
        return List.of(
                System.getProperty("java.home") + "/bin/java",
                "-cp", System.getProperty("java.class.path"),
                "dev.spectroscope.cli.SpectroCli");
    }
}
