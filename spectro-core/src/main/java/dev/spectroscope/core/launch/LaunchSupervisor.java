package dev.spectroscope.core.launch;

import java.io.BufferedReader;
import java.io.IOException;
import java.io.InputStreamReader;
import java.net.InetSocketAddress;
import java.net.Socket;
import java.net.URI;
import java.net.URISyntaxException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Duration;
import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.Deque;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Optional;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.TimeUnit;

/**
 * What is running for ONE session, and what dies with it (card 202).
 *
 * <p>A supervisor belongs to a session the way its browser does. That is not
 * symmetry for its own sake: a launched dev server is live state exactly like a
 * logged-in page, the session that started it is the only thing that knows why
 * it is up, and the session going away is the only event that can honestly be
 * called "done with it".
 *
 * <p><b>Stopping is the half that is easy to get wrong, so it is stated
 * plainly.</b> {@code npm run dev} is a shell that spawns Vite; killing the
 * shell leaves Vite holding the port with a new parent. So the descendants are
 * snapshotted BEFORE anything is signalled — after the parent dies the tree has
 * already been reparented and {@code descendants()} answers with nothing — and
 * they are signalled first. On top of that a JVM shutdown hook runs the same
 * sweep, because a spectro-server dies by SIGTERM and an orphaned dev server
 * outlives the agent that started it. {@code LaunchSupervisorReaperProofTest}
 * proves both against real PIDs in a real child JVM rather than asserting them.
 *
 * <p><b>An attached entry is not stopped here</b>, and that is a deliberate
 * non-decision. Card 202's open owner call lists three defensible answers for a
 * process spectroscope never spawned, and two of them are safe. Until the owner
 * picks, {@link #stop(String)} refuses for an attached entry and says which one
 * it was: nothing is killed, no attachment semantics are baked in, and all three
 * answers stay available. Killing whatever holds a port is the answer nobody
 * asked for and this class cannot reach it.
 */
public final class LaunchSupervisor implements AutoCloseable {

    /** How a supervisor finds out whether an address answers. A seam: tests answer from a table. */
    @FunctionalInterface
    public interface Probe {
        /**
         * Whether something accepts a TCP connection there.
         *
         * @param host the host to reach
         * @param port the port to reach
         * @return true when the address answers
         */
        boolean answers(String host, int port);
    }

    /** The production probe: one TCP connect, short timeout, no bytes sent. */
    public static final Probe TCP_CONNECT = (host, port) -> {
        try (Socket socket = new Socket()) {
            socket.connect(new InetSocketAddress(host, port), 400);
            return true;
        } catch (IOException | RuntimeException notYet) {
            return false;
        }
    };

    /** How long a start waits for the address to answer, unless the caller says otherwise. */
    public static final Duration DEFAULT_BUDGET = Duration.ofSeconds(45);

    /** How many lines of a launched process's output are kept. */
    static final int LOG_LINES = 400;

    /** How long a stop waits for a signalled tree before it stops being polite. */
    private static final long STOP_GRACE_MS = 3_000;

    /** How often the address is probed while a start waits. */
    private static final long PROBE_INTERVAL_MS = 150;

    /**
     * One configuration that is up.
     *
     * @param name     the configuration name
     * @param address  the address it answers on
     * @param attached true when spectroscope did not start it and does not own it
     * @param pid      the process id, or -1 for an attached entry
     */
    public record Running(String name, String address, boolean attached, long pid) {}

    /**
     * What one start did.
     *
     * @param ok      whether the configuration is up now
     * @param running what is up, or null when it is not
     * @param problem why it is not, in one clause, or null when it is
     * @param tail    the last output the process produced before it failed, or ""
     */
    public record Outcome(boolean ok, Running running, String problem, String tail) {}

    /**
     * What one stop did.
     *
     * @param stopped     whether a process was signalled
     * @param known       whether the name was running at all
     * @param wasAttached whether the entry was attached rather than started — the
     *                    case card 202 leaves to the owner
     */
    public record Stopped(boolean stopped, boolean known, boolean wasAttached) {}

    /**
     * What one log request found.
     *
     * @param known    whether the name is running here
     * @param attached whether it was attached, in which case there is no output to have
     * @param text     the captured output, oldest first
     */
    public record LogView(boolean known, boolean attached, String text) {}

    /** One launched or attached configuration and everything needed to end it. */
    private static final class Held {
        private final Running running;
        private final Process process;
        private final Deque<String> lines = new ArrayDeque<>();

        Held(Running running, Process process) {
            this.running = running;
            this.process = process;
        }

        void record(String line) {
            synchronized (lines) {
                lines.addLast(line);
                while (lines.size() > LOG_LINES) {
                    lines.removeFirst();
                }
            }
        }

        String text() {
            synchronized (lines) {
                return String.join("\n", lines);
            }
        }
    }

    private final Probe probe;
    private final Map<String, Held> held = new ConcurrentHashMap<>();
    private volatile Thread reaper;

    /**
     * Set by {@link #close()} before it reaps anything.
     *
     * <p>{@link #start} runs under this object's monitor and can hold it for the
     * whole port budget; {@code close()} deliberately does NOT take that monitor,
     * because it runs on the thread tearing a socket down and must not wait 45
     * seconds behind a start. That leaves one window — a process spawned while
     * close is already sweeping — and this flag is what shuts it: a spawn that
     * finds it set reaps its own child instead of registering an orphan.
     */
    private volatile boolean closed;

    /**
     * Builds a supervisor that holds nothing yet.
     *
     * @param probe how the supervisor decides an address answers
     */
    public LaunchSupervisor(Probe probe) {
        this.probe = probe;
    }

    /**
     * The supervisor a session gets: the real TCP probe.
     *
     * @return a supervisor that connects for real
     */
    public static LaunchSupervisor real() {
        return new LaunchSupervisor(TCP_CONNECT);
    }

    /**
     * Brings one configuration up: spawns it, or attaches when the entry carries
     * a url and no command.
     *
     * @param entry  the configuration, as the file carries it
     * @param cwd    the folder the process starts in and relative paths resolve against
     * @param budget how long to wait for the address to answer
     * @return what happened, as data — this never throws
     */
    public synchronized Outcome start(LaunchEntry entry, Path cwd, Duration budget) {
        String address = entry.address();
        if (address == null) {
            return new Outcome(false, null,
                    "it carries neither a port nor a url, so there is no address to open", "");
        }
        Running already = running(entry.name()).orElse(null);
        if (already != null) {
            return new Outcome(true, already, null, "");
        }
        if (entry.attaches()) {
            return attach(entry, address, budget);
        }
        return spawn(entry, cwd, address, budget);
    }

    /** The attach path: nothing is started, the address is asked whether it is there. */
    private Outcome attach(LaunchEntry entry, String address, Duration budget) {
        Endpoint endpoint = Endpoint.of(address);
        if (endpoint == null) {
            return new Outcome(false, null, "its url is not an address that can be reached", "");
        }
        if (!waitForAnswer(endpoint, budget, null)) {
            return new Outcome(false, null, "nothing answered there", "");
        }
        Running running = new Running(entry.name(), address, true, -1);
        held.put(entry.name(), new Held(running, null));
        return new Outcome(true, running, null, "");
    }

    /** The spawn path: run the command, drain its output, wait for the address. */
    private Outcome spawn(LaunchEntry entry, Path cwd, String address, Duration budget) {
        Endpoint endpoint = Endpoint.of(address);
        if (endpoint == null) {
            return new Outcome(false, null, "its address cannot be reached", "");
        }
        List<String> command = new ArrayList<>();
        command.add(resolveExecutable(entry.runtimeExecutable(), cwd));
        command.addAll(entry.runtimeArgs());
        Process process;
        try {
            process = new ProcessBuilder(command)
                    .directory(cwd.toFile())
                    .redirectErrorStream(true)
                    .start();
        } catch (IOException | RuntimeException notStarted) {
            return new Outcome(false, null,
                    "it could not be started: " + notStarted.getMessage(), "");
        }
        Running running = new Running(entry.name(), address, false, process.pid());
        Held entryHeld = new Held(running, process);
        held.put(entry.name(), entryHeld);
        if (closed) {
            // The session went away while this was spawning. Take it back out
            // rather than leaving a process nobody will ever close again.
            held.remove(entry.name(), entryHeld);
            reap(entryHeld);
            return new Outcome(false, null, "the session closed while it was starting", "");
        }
        ensureReaper();
        drain(process, entryHeld);
        if (waitForAnswer(endpoint, budget, process)) {
            return new Outcome(true, running, null, "");
        }
        // It never came up. Leave nothing behind: a half-started tree holding a
        // port is exactly the orphan this class exists to prevent.
        reap(entryHeld);
        held.remove(entry.name());
        String tail = entryHeld.text();
        String problem = process.isAlive()
                ? "it did not answer on " + address + " within "
                        + budget.toSeconds() + " seconds"
                : "it exited with code " + process.exitValue()
                        + " before " + address + " answered";
        return new Outcome(false, null, problem, tail);
    }

    /**
     * Where the executable actually is.
     *
     * <p>Claude Code's files write relative paths — {@code
     * spectroscope-harness/spectro/gradlew} is a real entry — and they are
     * relative to the PROJECT, not to whatever directory this JVM was launched
     * from. {@link ProcessBuilder} does not use its own {@code directory()} to
     * resolve the command, so a relative executable would be looked up against
     * the JVM's working directory and fail with a confusing "No such file". A
     * bare name is left alone so {@code npm}, {@code python3} and {@code java}
     * still come off the PATH.
     */
    private static String resolveExecutable(String executable, Path cwd) {
        if (executable.indexOf('/') < 0 && executable.indexOf('\\') < 0) {
            return executable;
        }
        Path candidate = cwd.resolve(executable);
        return Files.isRegularFile(candidate) ? candidate.toString() : executable;
    }

    /**
     * Reads the merged output on a virtual thread so a full pipe never stalls the
     * child. Decoded as UTF-8 rather than byte-per-char: a build error is exactly
     * the kind of line that carries a box-drawing character or an arrow, and a
     * mangled one is worse than none.
     */
    private static void drain(Process process, Held into) {
        Thread.startVirtualThread(() -> {
            try (BufferedReader reader = new BufferedReader(
                    new InputStreamReader(process.getInputStream(), OUTPUT_CHARSET))) {
                String line;
                while ((line = reader.readLine()) != null) {
                    into.record(line);
                }
            } catch (IOException torn) {
                // A reaped child tears the pipe down mid-read; the snapshot stands.
            }
        });
    }

    /** Polls the address until it answers, the budget runs out, or the process dies. */
    private boolean waitForAnswer(Endpoint endpoint, Duration budget, Process process) {
        long deadline = System.nanoTime() + budget.toNanos();
        while (true) {
            if (probe.answers(endpoint.host(), endpoint.port())) {
                return true;
            }
            if (process != null && !process.isAlive()) {
                // One last look: a server can answer and exit in the same breath
                // on a very short-lived command, and calling that a failure
                // would be a race the reader could never reproduce.
                return probe.answers(endpoint.host(), endpoint.port());
            }
            if (System.nanoTime() >= deadline) {
                return false;
            }
            try {
                TimeUnit.MILLISECONDS.sleep(PROBE_INTERVAL_MS);
            } catch (InterruptedException interrupted) {
                Thread.currentThread().interrupt();
                return false;
            }
        }
    }

    /**
     * What is up under this name.
     *
     * @param name the configuration name
     * @return what is running, or empty
     */
    public Optional<Running> running(String name) {
        Held current = name == null ? null : held.get(name);
        if (current == null) {
            return Optional.empty();
        }
        if (current.process != null && !current.process.isAlive()) {
            held.remove(name, current);
            return Optional.empty();
        }
        return Optional.of(current.running);
    }

    /**
     * Everything this session has up, in no particular order.
     *
     * @return the running configurations
     */
    public List<Running> running() {
        List<Running> out = new ArrayList<>();
        held.keySet().forEach(name -> running(name).ifPresent(out::add));
        return out;
    }

    /**
     * Ends one configuration.
     *
     * @param name the configuration name
     * @return what happened — see {@link Stopped} for the attached case
     */
    public synchronized Stopped stop(String name) {
        Held current = name == null ? null : held.get(name);
        if (current == null) {
            return new Stopped(false, false, false);
        }
        if (current.process == null) {
            // The open owner call. Nothing is killed and the attachment is kept,
            // so refusing here forecloses none of the three answers.
            return new Stopped(false, true, true);
        }
        held.remove(name, current);
        reap(current);
        return new Stopped(true, true, false);
    }

    /**
     * What one configuration has printed.
     *
     * @param name  the configuration name
     * @param lines how many lines from the end, at most
     * @return the view — {@link LogView#attached()} is the case with no output to have
     */
    public LogView logs(String name, int lines) {
        Held current = name == null ? null : held.get(name);
        if (current == null) {
            return new LogView(false, false, "");
        }
        if (current.process == null) {
            return new LogView(true, true, "");
        }
        String all = current.text();
        if (lines <= 0) {
            return new LogView(true, false, all);
        }
        String[] split = all.split("\n", -1);
        int from = Math.max(0, split.length - lines);
        return new LogView(true, false,
                String.join("\n", List.of(split).subList(from, split.length)));
    }

    /**
     * Ends everything this session started. Attachments are dropped, not killed —
     * there is nothing here that spectroscope owns.
     *
     * <p>Called when the session's socket goes away, which is the same event that
     * closes its browser, and by the JVM shutdown hook.
     */
    @Override
    public void close() {
        closed = true;
        held.values().forEach(LaunchSupervisor::reap);
        held.clear();
        Thread hook = this.reaper;
        this.reaper = null;
        if (hook != null) {
            try {
                Runtime.getRuntime().removeShutdownHook(hook);
            } catch (IllegalStateException duringShutdown) {
                // The hook itself is calling us — nothing left to deregister.
            }
        }
    }

    /** One shutdown hook per supervisor, added the first time something is spawned. */
    private synchronized void ensureReaper() {
        if (reaper != null) {
            return;
        }
        Thread hook = new Thread(this::close, "spectro-launch-reaper");
        try {
            Runtime.getRuntime().addShutdownHook(hook);
            reaper = hook;
        } catch (IllegalStateException alreadyShuttingDown) {
            // The JVM is on its way out; the close below the caller still runs.
            reaper = null;
        }
    }

    /**
     * Ends one process and everything it spawned.
     *
     * <p>The order is the whole lesson: the descendants are collected while the
     * parent still holds them, then signalled, then the parent. Reversing it
     * leaves a reparented dev server holding the port.
     */
    private static void reap(Held current) {
        Process process = current.process;
        if (process == null || !process.isAlive()) {
            return;
        }
        List<ProcessHandle> tree = process.toHandle().descendants().toList();
        tree.forEach(ProcessHandle::destroy);
        process.destroy();
        long deadline = System.currentTimeMillis() + STOP_GRACE_MS;
        while (System.currentTimeMillis() < deadline
                && (process.isAlive() || tree.stream().anyMatch(ProcessHandle::isAlive))) {
            try {
                TimeUnit.MILLISECONDS.sleep(50);
            } catch (InterruptedException interrupted) {
                Thread.currentThread().interrupt();
                break;
            }
        }
        tree.stream().filter(ProcessHandle::isAlive).forEach(ProcessHandle::destroyForcibly);
        if (process.isAlive()) {
            process.destroyForcibly();
        }
    }

    /**
     * A host and a port out of an address, for the probe.
     *
     * @param host the host to connect to
     * @param port the port to connect to
     */
    record Endpoint(String host, int port) {

        /**
         * Reads an address.
         *
         * @param address the http(s) address
         * @return the endpoint, or null when the address carries no reachable host
         */
        static Endpoint of(String address) {
            URI uri;
            try {
                uri = new URI(address);
            } catch (URISyntaxException notAnAddress) {
                return null;
            }
            String host = uri.getHost();
            if (host == null || host.isBlank()) {
                return null;
            }
            int port = uri.getPort();
            if (port <= 0) {
                port = "https".equals(String.valueOf(uri.getScheme())
                        .toLowerCase(Locale.ROOT)) ? 443 : 80;
            }
            return new Endpoint(host, port);
        }
    }

    /** The character set the drain reads output as, named so it is not a guess. */
    static final java.nio.charset.Charset OUTPUT_CHARSET = StandardCharsets.UTF_8;
}
