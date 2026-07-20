package dev.spectroscope.core.tools;

import dev.spectroscope.core.CancelSignal;

import java.io.ByteArrayOutputStream;
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
        Process process = null;
        Runnable deregister = () -> { };
        try {
            ProcessBuilder builder = new ProcessBuilder("/bin/sh", "-c", command)
                    .directory(cwd.toFile())
                    .redirectErrorStream(true);
            builder.environment().putAll(extraEnv);
            process = builder.start();
            Process running = process;
            deregister = signal.onCancel(running::destroyForcibly);

            // Bound the buffer in bytes (UTF-8 worst case per char) — the drain keeps
            // reading past the cap so the child never blocks on a full pipe.
            int capBytes = maxOutputChars > Integer.MAX_VALUE / 4
                    ? Integer.MAX_VALUE : maxOutputChars * 4;
            ByteArrayOutputStream buffer = new ByteArrayOutputStream();
            Thread drainer = Thread.startVirtualThread(() -> {
                try (InputStream in = running.getInputStream()) {
                    byte[] chunk = new byte[8192];
                    int n;
                    while ((n = in.read(chunk)) != -1) {
                        synchronized (buffer) {
                            int room = capBytes - buffer.size();
                            if (room > 0) {
                                buffer.write(chunk, 0, Math.min(n, room));
                            }
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
                output = buffer.toString(StandardCharsets.UTF_8);
            }
            return new Result(process.exitValue(), ToolOutput.clip(output, maxOutputChars),
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
}
