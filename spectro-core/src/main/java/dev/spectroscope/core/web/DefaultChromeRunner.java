package dev.spectroscope.core.web;

import dev.spectroscope.core.CancelSignal;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.util.List;
import java.util.concurrent.TimeUnit;

/**
 * The production {@link BrowsePageTool.ChromeRunner}: exec's the argv DIRECTLY
 * (never through a shell — the URL element is untrusted model output) and
 * captures stdout and stderr on SEPARATE virtual-thread drains, because the
 * dumped DOM must not be interleaved with Chrome's warnings. The drain-while-
 * waiting pattern is {@code ShellCommand}'s: a page bigger than the OS pipe
 * buffer still exits, so a timeout means "genuinely hung", never "output too
 * large". Cancellation kills the child; every failure mode returns as data.
 */
public final class DefaultChromeRunner implements BrowsePageTool.ChromeRunner {

    /** Exit code stand-in when the process never produced one (timeout/failure). */
    static final int NO_EXIT = -1;

    /** Raw DOM cap in bytes — plenty for the tool's 10k-char text, a hard memory ceiling. */
    static final int MAX_DOM_BYTES = 2 * 1024 * 1024;

    /** Chrome's diagnostics only feed a short error tail — no reason to keep more. */
    static final int MAX_STDERR_BYTES = 16 * 1024;

    /** How long after child exit we wait for the drains to finish. */
    private static final long DRAIN_GRACE_MS = 1_000;

    /** One argv exec, blocking until exit, timeout or cancellation — see the class contract. */
    @Override
    public Result run(List<String> argv, long timeoutSeconds, CancelSignal signal) {
        Process process = null;
        Runnable deregister = () -> { };
        try {
            process = new ProcessBuilder(argv).start();
            Process running = process;
            deregister = signal.onCancel(running::destroyForcibly);

            ByteArrayOutputStream stdout = new ByteArrayOutputStream();
            ByteArrayOutputStream stderr = new ByteArrayOutputStream();
            Thread stdoutDrain = drain(running.getInputStream(), stdout, MAX_DOM_BYTES);
            Thread stderrDrain = drain(running.getErrorStream(), stderr, MAX_STDERR_BYTES);

            boolean finished = process.waitFor(timeoutSeconds, TimeUnit.SECONDS);
            if (!finished) {
                process.destroyForcibly();
                return new Result(NO_EXIT, "", "", true, null);
            }
            stdoutDrain.join(DRAIN_GRACE_MS);
            stderrDrain.join(DRAIN_GRACE_MS);
            return new Result(process.exitValue(),
                    text(stdout), text(stderr), false, null);
        } catch (IOException | RuntimeException error) {
            if (process != null) {
                process.destroyForcibly();
            }
            return new Result(NO_EXIT, "", "", false, error.getMessage());
        } catch (InterruptedException interrupted) {
            if (process != null) {
                process.destroyForcibly();
            }
            Thread.currentThread().interrupt();
            return new Result(NO_EXIT, "", "", false, "interrupted");
        } finally {
            deregister.run();
        }
    }

    /**
     * Starts a virtual-thread drain that keeps reading past the cap so the
     * child never blocks on a full pipe — only the first {@code capBytes}
     * are kept.
     *
     * @param in       the child's stream, closed by the drain in every case
     * @param buffer   where the capped bytes accumulate
     * @param capBytes hard ceiling on the kept bytes
     * @return the started drain thread, for the caller to join
     */
    private static Thread drain(InputStream in, ByteArrayOutputStream buffer, int capBytes) {
        return Thread.startVirtualThread(() -> {
            try (in) {
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
    }

    /**
     * Snapshot of a drain buffer as UTF-8 text.
     *
     * @param buffer the drain's accumulator
     * @return the decoded text, possibly capped
     */
    private static String text(ByteArrayOutputStream buffer) {
        synchronized (buffer) {
            return buffer.toString(StandardCharsets.UTF_8);
        }
    }
}
