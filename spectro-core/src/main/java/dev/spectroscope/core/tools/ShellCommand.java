package dev.spectroscope.core.tools;

import dev.spectroscope.core.CancelSignal;

import java.io.IOException;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.nio.file.Path;
import java.util.Map;
import java.util.concurrent.TimeUnit;

/**
 * The one shell-process runner behind {@code run_command} and the hook runner.
 * Spawns {@code /bin/sh -c}, merges stderr into stdout and DRAINS the pipe on a
 * background virtual thread while waiting — a child that prints more than the
 * OS pipe buffer still exits, so a timeout means "genuinely hung", never
 * "output too large". That distinction is load-bearing for hooks: a timed-out
 * pre_tool_use hook is fail-open, so a drain-less runner would let a
 * large-output guard be bypassed.
 *
 * <p>Cancellation kills the child; the cancel listener is deregistered after
 * completion so long runs do not accumulate dead Process references on the
 * run-scoped {@link CancelSignal}.</p>
 */
public final class ShellCommand {

    /** Exit code stand-in when the process never produced one (timeout/failure). */
    public static final int NO_EXIT = -1;

    /** How long after child exit we wait for the drain to finish. Normally the
     *  exit closes the pipe instantly; a background grandchild holding the fd
     *  open must not hang the tool, so we take the partial snapshot instead. */
    private static final long DRAIN_GRACE_MS = 1_000;

    /**
     * The outcome of one shell run — every failure mode is data here, never an exception.
     *
     * @param exitCode the child's exit code, or {@link #NO_EXIT}
     * @param output   merged stdout+stderr, clipped to the caller's cap
     * @param timedOut the child was killed at the timeout
     * @param failure  exception message when the spawn/wait itself failed, else null
     */
    public record Result(int exitCode, String output, boolean timedOut, String failure) {
    }

    /** Static utility — no instances. */
    private ShellCommand() {
    }

    /**
     * Lays the tool environment into a spawn's map: the deliberate PATH first,
     * the caller's entries over it.
     *
     * <p>This is the one place the agent's shells get their PATH, so it is where
     * card 251's policy lands — see {@link ToolPath} for what it adds and what
     * it refuses to guess. It lives in the JVM rather than in the desktop shell
     * on purpose: the Electron app, {@code spectro run} and a launchd service
     * all spawn tools through here, so one implementation cannot diverge between
     * a Finder launch and a terminal launch the way two would.
     *
     * <p>The order is load-bearing in both directions. The policy has to overwrite
     * an inherited PATH (that is the defect), and a caller that passes PATH
     * explicitly — a hook config, a test — has to overwrite the policy.
     *
     * @param environment the builder's live environment map, mutated in place
     * @param extraEnv    the caller's entries, applied last so they win
     */
    static void applyEnvironment(Map<String, String> environment, Map<String, String> extraEnv) {
        environment.put("PATH", ToolPath.resolve().path());
        environment.putAll(extraEnv);
    }

    /**
     * Runs one command via {@code /bin/sh -c} and blocks until exit, timeout or
     * cancellation. Output (stdout+stderr merged) is drained concurrently and
     * clipped to the caller's cap; every failure mode comes back as data in the
     * {@link Result}, never as an exception.
     *
     * @param command        the shell line, passed verbatim to sh -c
     * @param extraEnv       environment entries layered over the inherited environment
     * @param cwd            working directory the child starts in
     * @param timeoutSeconds wall-clock budget; overrun kills the child and sets timedOut
     * @param signal         run-scoped cancel — cancelling kills the child immediately
     * @param maxOutputChars cap for the returned output; the drain keeps reading past it
     * @return exit code, clipped output and the failure flags — see {@link Result}
     */
    public static Result run(String command, Map<String, String> extraEnv, Path cwd,
                             long timeoutSeconds, CancelSignal signal, int maxOutputChars) {
        return run(command, extraEnv, cwd, timeoutSeconds, signal, maxOutputChars, false);
    }

    /**
     * The same run, with a say in WHICH end of an over-long output survives.
     *
     * <p>Head is the default and stays the default for every tool and hook: a
     * tool result is read from the top. A goal's check is the one caller that
     * asks for the tail, because a test suite prints its failure last — card
     * 267's review found the guidance handing a model 4.000 characters of
     * "ok N" lines with the failing assertion cut off. The cut is made in the
     * DRAIN, not afterwards, so the memory bound is the same either way: a
     * suite that prints a gigabyte still costs one small buffer.</p>
     *
     * @param command        the shell line, passed verbatim to sh -c
     * @param extraEnv       environment entries layered over the inherited environment
     * @param cwd            working directory the child starts in
     * @param timeoutSeconds wall-clock budget; overrun kills the child and sets timedOut
     * @param signal         run-scoped cancel — cancelling kills the child immediately
     * @param maxOutputChars cap for the returned output
     * @param keepTail       true to keep the END of the output instead of the beginning
     * @return exit code, clipped output and the failure flags — see {@link Result}
     */
    public static Result run(String command, Map<String, String> extraEnv, Path cwd,
                             long timeoutSeconds, CancelSignal signal, int maxOutputChars,
                             boolean keepTail) {
        Process process = null;
        Runnable deregister = () -> { };
        try {
            ProcessBuilder builder = new ProcessBuilder("/bin/sh", "-c", command)
                    .directory(cwd.toFile())
                    .redirectErrorStream(true);
            applyEnvironment(builder.environment(), extraEnv);
            process = builder.start();
            Process running = process;
            deregister = signal.onCancel(running::destroyForcibly);

            // Bound the buffer in bytes (UTF-8 worst case per char) — the drain keeps
            // reading past the cap so the child never blocks on a full pipe.
            int capBytes = maxOutputChars > Integer.MAX_VALUE / 4
                    ? Integer.MAX_VALUE : maxOutputChars * 4;
            Sink buffer = new Sink(capBytes, keepTail);
            Thread drainer = Thread.startVirtualThread(() -> {
                try (InputStream in = running.getInputStream()) {
                    byte[] chunk = new byte[8192];
                    int n;
                    while ((n = in.read(chunk)) != -1) {
                        synchronized (buffer) {
                            buffer.write(chunk, n);
                        }
                    }
                } catch (IOException ignored) {
                    // A killed child tears the pipe down mid-read; the snapshot stands.
                }
            });

            boolean finished = process.waitFor(timeoutSeconds, TimeUnit.SECONDS);
            if (!finished) {
                process.destroyForcibly();
                return new Result(NO_EXIT, "", true, null);
            }
            drainer.join(DRAIN_GRACE_MS);
            String output;
            synchronized (buffer) {
                output = buffer.text();
            }
            return new Result(process.exitValue(),
                    keepTail ? ToolOutput.clipTail(output, maxOutputChars)
                            : ToolOutput.clip(output, maxOutputChars),
                    false, null);
        } catch (IOException | RuntimeException error) {
            if (process != null) {
                process.destroyForcibly();
            }
            return new Result(NO_EXIT, "", false, error.getMessage());
        } catch (InterruptedException interrupted) {
            if (process != null) {
                process.destroyForcibly();
            }
            Thread.currentThread().interrupt();
            return new Result(NO_EXIT, "", false, "interrupted");
        } finally {
            deregister.run();
        }
    }

    /**
     * The drain's bounded byte sink — the first {@code cap} bytes, or the last
     * {@code cap} bytes, and never more than {@code cap} bytes of memory either
     * way. The reader keeps reading past the bound in both modes, which is what
     * keeps a chatty child from blocking on a full pipe.
     */
    private static final class Sink {
        private final byte[] held;
        private final boolean keepTail;
        private int at;
        private boolean wrapped;

        Sink(int cap, boolean keepTail) {
            this.held = new byte[Math.max(1, cap)];
            this.keepTail = keepTail;
        }

        /** Takes one chunk.
         *  @param chunk the bytes just read
         *  @param n     how many of them are real */
        void write(byte[] chunk, int n) {
            if (!keepTail) {
                int room = held.length - at;
                if (room > 0) {
                    System.arraycopy(chunk, 0, held, at, Math.min(n, room));
                    at += Math.min(n, room);
                }
                return;
            }
            // Only the last held.length bytes of this chunk can survive it.
            for (int i = Math.max(0, n - held.length); i < n; i++) {
                held[at] = chunk[i];
                at++;
                if (at == held.length) {
                    at = 0;
                    wrapped = true;
                }
            }
        }

        /** What was kept, decoded.
         *  @return the held bytes as UTF-8, never starting mid-character */
        String text() {
            if (!keepTail || !wrapped) {
                return new String(held, 0, at, StandardCharsets.UTF_8);
            }
            byte[] out = new byte[held.length];
            System.arraycopy(held, at, out, 0, held.length - at);
            System.arraycopy(held, 0, out, held.length - at, at);
            // The cut landed anywhere, including inside a multi-byte character:
            // skip continuation bytes so the first char is not a replacement glyph.
            int from = 0;
            while (from < out.length && (out[from] & 0xC0) == 0x80) {
                from++;
            }
            return new String(out, from, out.length - from, StandardCharsets.UTF_8);
        }
    }
}
