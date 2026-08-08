package dev.spectroscope.server.shell;

import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.concurrent.TimeUnit;
import java.util.function.Predicate;
import java.util.function.Supplier;

/**
 * Runs the bundled {@code spectro-pty} helper (see {@code native/spectro-pty.c}).
 *
 * <p>The helper is ours rather than a library for two reasons the card's risk
 * section predicted. It rides {@code spectro-desktop/bin}, the directory
 * {@code build-desktop-runkit.sh} already signs inside-out with the Developer ID
 * and hardened runtime, so the DMG story needs no change at all — where pty4j
 * would dlopen a dylib extracted from its jar at runtime, which library
 * validation rejects under that same hardened runtime, working in dev and
 * breaking in the shipped app. And the helper dies when its stdin reaches EOF,
 * which is the only way a shell survives nothing: a {@code kill -9} of the server
 * runs no shutdown hook and calls no {@code destroy()}, but it does close the
 * pipe.</p>
 *
 * <p>What a browser gets to influence stops at the session id and the window
 * size. The program, its arguments, its environment and its directory are all
 * decided here.</p>
 */
public final class HelperPtyProvider implements PtyProvider {

    /** Shells whose rc files only load for a login + interactive shell. */
    private static final List<String> RC_SHELLS = List.of("zsh", "bash");

    /** The fallbacks when {@code $SHELL} is unset or unusable, in order. */
    private static final List<String> FALLBACK_SHELLS = List.of("/bin/zsh", "/bin/bash", "/bin/sh");

    /**
     * Environment keys stripped before the shell starts. The server's own process
     * environment can carry provider keys (the Gradle build loads {@code .env}
     * into it), and a terminal the operator opens themselves would not have them.
     * Handing them to a browser-driven shell would widen what a page that got
     * past the fence could read, so they do not travel.
     */
    private static final List<String> SECRET_SUFFIXES =
            List.of("_API_KEY", "_TOKEN", "_SECRET", "_PASSWORD", "_BASIC_AUTH", "_CREDENTIALS");

    private final Supplier<Path> binary;
    private final Supplier<String> shellEnv;

    /** Production wiring: the bundled or repo-local helper, and {@code $SHELL}. */
    public HelperPtyProvider() {
        this(HelperPtyProvider::locate, () -> System.getenv("SHELL"));
    }

    /** Seam: pin the helper path (tests, and the availability probe). */
    HelperPtyProvider(Supplier<Path> binary) {
        this(binary, () -> System.getenv("SHELL"));
    }

    /**
     * Full seam.
     *
     * @param binary   supplies the helper path, or null when there is none
     * @param shellEnv supplies the {@code $SHELL} value
     */
    HelperPtyProvider(Supplier<Path> binary, Supplier<String> shellEnv) {
        this.binary = binary;
        this.shellEnv = shellEnv;
    }

    @Override
    public boolean available() {
        return binary.get() != null;
    }

    @Override
    public String shellPath() {
        return resolveShell(shellEnv.get(), HelperPtyProvider::isExecutable);
    }

    @Override
    public Pty open(Path cwd, int rows, int cols) throws IOException {
        Path helper = binary.get();
        if (helper == null) {
            throw new IOException("no spectro-pty helper for this install");
        }
        String shell = shellPath();
        ProcessBuilder pb = new ProcessBuilder(
                buildCommand(helper.toString(), rows, cols, shell, shellArgs(shell)));
        pb.directory(cwd.toFile());
        // Diagnostics from the helper itself (an exec failure) must not be mixed
        // into the terminal stream the client renders.
        pb.redirectError(ProcessBuilder.Redirect.DISCARD);
        sanitizeEnv(pb.environment());
        pb.environment().put("TERM", "xterm-256color");
        pb.environment().put("COLORTERM", "truecolor");
        return new HelperPty(pb.start());
    }

    // ---- the pure decisions ----------------------------------------------------

    /**
     * Which shell to start. {@code $SHELL} is where oh-my-zsh lives, so it wins —
     * but only as an absolute, executable path: resolving a bare name through
     * {@code PATH} would let an inherited PATH decide what runs.
     *
     * @param envShell   the {@code $SHELL} value, possibly null
     * @param executable the is-executable test (a seam, so this stays pure)
     * @return the shell to exec; {@code /bin/sh} as the last resort even if the
     *         probe says no, because refusing to name one helps nobody
     */
    static String resolveShell(String envShell, Predicate<String> executable) {
        if (envShell != null && envShell.startsWith("/") && executable.test(envShell)) {
            return envShell;
        }
        for (String candidate : FALLBACK_SHELLS) {
            if (executable.test(candidate)) {
                return candidate;
            }
        }
        return "/bin/sh";
    }

    /**
     * The flags. {@code -l -i} is what makes {@code .zprofile} and {@code .zshrc}
     * load, which is the entire point of the oh-my-zsh support; a shell that reads
     * neither gets plain {@code -i}.
     *
     * @param shell the resolved shell path
     * @return the argument list
     */
    static List<String> shellArgs(String shell) {
        String name = shell.substring(shell.lastIndexOf('/') + 1).toLowerCase(Locale.ROOT);
        return RC_SHELLS.contains(name) ? List.of("-l", "-i") : List.of("-i");
    }

    /**
     * The helper's command line.
     *
     * @param helper the helper binary
     * @param rows   initial height
     * @param cols   initial width
     * @param shell  the shell to exec
     * @param args   the shell's arguments
     * @return the full command
     */
    static List<String> buildCommand(String helper, int rows, int cols, String shell,
            List<String> args) {
        List<String> command = new ArrayList<>();
        command.add(helper);
        command.add(String.valueOf(rows));
        command.add(String.valueOf(cols));
        command.add("--");
        command.add(shell);
        command.addAll(args);
        return command;
    }

    /**
     * Removes provider keys and other secrets from a child environment, in place.
     *
     * @param env the mutable child environment
     * @return the same map, for chaining in tests
     */
    static Map<String, String> sanitizeEnv(Map<String, String> env) {
        env.keySet().removeIf(key -> {
            String upper = key.toUpperCase(Locale.ROOT);
            return SECRET_SUFFIXES.stream().anyMatch(upper::endsWith);
        });
        return env;
    }

    /**
     * Where the helper lives: an explicit override first, then the packaged app's
     * binary directory (the same {@code spectro.bundle.bin} the llama-server uses),
     * then the repo layout so a dev build works after one
     * {@code scripts/build-spectro-pty.sh}. Deliberately NOT {@code PATH} —
     * nothing installs a {@code spectro-pty}, so a PATH hit would be somebody
     * else's binary.
     *
     * @return the helper path, or null when this install has none
     */
    static Path locate() {
        Path explicit = executableOrNull(System.getProperty("spectro.pty.bin"));
        if (explicit != null) {
            return explicit;
        }
        explicit = executableOrNull(System.getenv("SPECTRO_PTY_BIN"));
        if (explicit != null) {
            return explicit;
        }
        String bundleDir = System.getProperty("spectro.bundle.bin");
        if (bundleDir != null && !bundleDir.isBlank()) {
            Path bundled = Path.of(bundleDir, "spectro-pty");
            if (isExecutable(bundled.toString())) {
                return bundled;
            }
        }
        // The dev tree: gradle runs tests from the module directory and bootRun
        // from the root, so walk up a few levels rather than guess which.
        Path here = Path.of(System.getProperty("user.dir", ".")).toAbsolutePath().normalize();
        for (int up = 0; up < 4 && here != null; up++, here = here.getParent()) {
            Path candidate = here.resolve("spectro-desktop").resolve("bin").resolve("spectro-pty");
            if (isExecutable(candidate.toString())) {
                return candidate;
            }
        }
        return null;
    }

    private static Path executableOrNull(String path) {
        if (path == null || path.isBlank() || !isExecutable(path)) {
            return null;
        }
        return Path.of(path);
    }

    private static boolean isExecutable(String path) {
        try {
            Path resolved = Path.of(path);
            return Files.isRegularFile(resolved) && Files.isExecutable(resolved);
        } catch (RuntimeException malformed) {
            return false;
        }
    }

    // ---- the live terminal ------------------------------------------------------

    /**
     * One helper process. Both frame types travel down the same pipe, so writes
     * are serialized here; callers keep that off any container thread by going
     * through {@link ShellSession}'s queue.
     */
    private static final class HelperPty implements Pty {

        private final Process process;
        private final OutputStream toHelper;
        private final Object writeLock = new Object();
        private volatile boolean closed;

        HelperPty(Process process) {
            this.process = process;
            this.toHelper = process.getOutputStream();
        }

        @Override
        public InputStream output() {
            return process.getInputStream();
        }

        @Override
        public void write(byte[] data) throws IOException {
            frame((byte) 0x00, data);
        }

        @Override
        public void resize(int rows, int cols) throws IOException {
            frame((byte) 0x01, new byte[] {
                    (byte) (rows >>> 8), (byte) rows, (byte) (cols >>> 8), (byte) cols});
        }

        private void frame(byte type, byte[] payload) throws IOException {
            if (closed) {
                return;
            }
            byte[] out = new byte[5 + payload.length];
            out[0] = type;
            out[1] = (byte) (payload.length >>> 24);
            out[2] = (byte) (payload.length >>> 16);
            out[3] = (byte) (payload.length >>> 8);
            out[4] = (byte) payload.length;
            System.arraycopy(payload, 0, out, 5, payload.length);
            synchronized (writeLock) {
                toHelper.write(out);
                toHelper.flush();
            }
        }

        @Override
        public boolean alive() {
            return process.isAlive();
        }

        @Override
        public long pid() {
            return process.pid();
        }

        @Override
        public int awaitExit(long millis) {
            try {
                if (process.waitFor(millis, TimeUnit.MILLISECONDS)) {
                    return process.exitValue();
                }
            } catch (InterruptedException interrupted) {
                Thread.currentThread().interrupt();
            }
            return -1;
        }

        /**
         * Close stdin FIRST: that is the helper's own signal to take the shell's
         * process group down, and it is the path that also covers a JVM killed
         * hard enough that this method never runs. destroy() is the belt.
         */
        @Override
        public void close() {
            closed = true;
            try {
                synchronized (writeLock) {
                    toHelper.close();
                }
            } catch (IOException alreadyGone) {
                // nothing to close — the helper is already finished
            }
            try {
                if (!process.waitFor(1500, TimeUnit.MILLISECONDS)) {
                    process.destroy();
                    if (!process.waitFor(1500, TimeUnit.MILLISECONDS)) {
                        process.destroyForcibly();
                    }
                }
            } catch (InterruptedException interrupted) {
                process.destroyForcibly();
                Thread.currentThread().interrupt();
            }
        }
    }
}
