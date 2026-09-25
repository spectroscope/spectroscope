package dev.spectroscope.core.tools;

import dev.spectroscope.core.CancelSignal;
import dev.spectroscope.core.config.governing.Governs;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import java.io.IOException;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.nio.file.Path;
import java.util.List;
import java.util.Map;
import java.util.concurrent.TimeUnit;
import java.util.function.Function;

/**
 * The one shell-process runner behind {@code run_command} and the hook runner.
 * Spawns {@code /bin/sh -c}, merges stderr into stdout and DRAINS the pipe on a
 * background virtual thread while waiting — a child that prints more than the
 * OS pipe buffer still exits, so a timeout means "genuinely hung", never
 * "output too large". That distinction is load-bearing for hooks: a timed-out
 * pre_tool_use hook is fail-open, so a drain-less runner would let a
 * large-output guard be bypassed.
 *
 * <p>A cut, by the time limit, a cancel or an interrupt, kills the shell and
 * the processes that were below it at one census taken at the cut (card 385).
 * A process started below it after that census, and a process that left the
 * tree before the cut, are not reached; the nested class {@code Tree} says
 * how. A command that ends on its own is left alone, and so is whatever it
 * left running in the background. The cancel listener is deregistered after
 * completion so long runs do not accumulate dead Process references on the
 * run-scoped {@link CancelSignal}.</p>
 */
public final class ShellCommand {

    private static final Logger log = LoggerFactory.getLogger(ShellCommand.class);

    /** Exit code stand-in when the process never produced one (timeout/failure). */
    @Governs(kind = Governs.Kind.PLUMBING, unit = Governs.Unit.NONE)
    public static final int NO_EXIT = -1;

    /** How long the drain is waited for once the child has exited, and after a
     *  time limit, once the killed processes are gone or {@link #REAP_GRACE_MS}
     *  is over. Normally the end of the child closes the pipe at once. A background grandchild that holds the pipe open must
     *  not hang the tool, so after this wait the output read so far is taken. */
    @Governs(kind = Governs.Kind.FIXED, unit = Governs.Unit.MILLISECONDS)
    private static final long DRAIN_GRACE_MS = 1_000;

    /** How long a cut waits for the processes it killed to be gone. A time
     *  limit or a cancel kills the shell and the processes the census found
     *  below it, and the run waits until none of those is alive, or until this
     *  wait is over, before it takes the output. */
    @Governs(kind = Governs.Kind.FIXED, unit = Governs.Unit.MILLISECONDS)
    public static final long REAP_GRACE_MS = 2_000;

    /** How often a cut looks again whether the processes it killed are gone. */
    @Governs(kind = Governs.Kind.PLUMBING, unit = Governs.Unit.MILLISECONDS)
    private static final long REAP_POLL_MS = 10;

    /**
     * The outcome of one shell run — every failure mode is data here, never an exception.
     *
     * @param exitCode the child's exit code, or {@link #NO_EXIT}
     * @param output   merged stdout+stderr, clipped to the caller's cap. On a
     *                 timeout it is the END of what was printed, read until the
     *                 pipe closes or for at most about {@link #REAP_GRACE_MS}
     *                 plus {@link #DRAIN_GRACE_MS} after the kill, whichever end
     *                 the caller keeps otherwise (card 384)
     * @param timedOut the time limit cut the command: the shell and the processes
     *                 the census found below it were killed
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
     * @param timeoutSeconds wall-clock budget; overrun kills the shell and the processes
     *                       below it at that moment, and sets timedOut
     * @param signal         run-scoped cancel; cancelling kills the shell and the
     *                       processes below it at that moment
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
     * <p>The choice applies to a command that finishes. There head is the
     * default for every tool and hook: a tool result is read from the top. A
     * goal's check is the one caller that asks for the tail, because a test
     * suite prints its failure last. Card 267's review found the guidance
     * handing a model 4.000 characters of "ok N" lines with the failing
     * assertion cut off. The cut is made in the DRAIN, not afterwards, so the
     * memory bound is the same either way: a suite that prints a gigabyte
     * still costs one small buffer.</p>
     *
     * <p>A command killed at its time limit hands back the END of its output
     * whatever {@code keepTail} says (card 384). For a head keeping caller
     * whose output outgrew the drain's buffer, that end is what the ring held,
     * and {@code headRing} sets the ring's size.</p>
     *
     * @param command        the shell line, passed verbatim to sh -c
     * @param extraEnv       environment entries layered over the inherited environment
     * @param cwd            working directory the child starts in
     * @param timeoutSeconds wall-clock budget; overrun kills the shell and the processes
     *                       below it at that moment, and sets timedOut
     * @param signal         run-scoped cancel; cancelling kills the shell and the
     *                       processes below it at that moment
     * @param maxOutputChars cap for the returned output
     * @param keepTail      true to keep the END of a finished command's output instead
     *                       of its beginning; a timed out command's end is kept either way
     * @return exit code, clipped output and the failure flags — see {@link Result}
     */
    public static Result run(String command, Map<String, String> extraEnv, Path cwd,
                             long timeoutSeconds, CancelSignal signal, int maxOutputChars,
                             boolean keepTail) {
        return run(command, extraEnv, cwd, timeoutSeconds, signal, maxOutputChars, keepTail,
                ShellCommand::below);
    }

    /**
     * The same run with the census of the processes below the shell handed in.
     * Production passes {@code below}. A test passes a census
     * that throws, the way the JDK's native walk can.
     *
     * @param command        the shell line, passed verbatim to sh -c
     * @param extraEnv       environment entries layered over the inherited environment
     * @param cwd            working directory the child starts in
     * @param timeoutSeconds wall-clock budget
     * @param signal         run-scoped cancel
     * @param maxOutputChars cap for the returned output
     * @param keepTail       true to keep the END of a finished command's output
     * @param census         lists the processes below the shell at the moment of a cut
     * @return exit code, clipped output and the failure flags, see {@link Result}
     */
    static Result run(String command, Map<String, String> extraEnv, Path cwd,
                      long timeoutSeconds, CancelSignal signal, int maxOutputChars,
                      boolean keepTail, Function<ProcessHandle, List<ProcessHandle>> census) {
        Process process = null;
        Tree tree = null;
        Runnable deregister = () -> { };
        try {
            ProcessBuilder builder = new ProcessBuilder("/bin/sh", "-c", command)
                    .directory(cwd.toFile())
                    .redirectErrorStream(true);
            applyEnvironment(builder.environment(), extraEnv);
            process = builder.start();
            Process running = process;
            tree = new Tree(running, census);
            deregister = signal.onCancel(tree::end);

            // Bound the buffer in bytes (UTF-8 worst case per char) — the drain keeps
            // reading past the cap so the child never blocks on a full pipe.
            int capBytes = maxOutputChars > Integer.MAX_VALUE / 4
                    ? Integer.MAX_VALUE : maxOutputChars * 4;
            Sink buffer = new Sink(capBytes, keepTail ? capBytes : headRing(capBytes, maxOutputChars));
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
                tree.end();
                tree.awaitGone();
                // Card 384: the drain holds what the child printed until the kill.
                // A cut build prints its failure last, so the end is handed back.
                drainer.join(DRAIN_GRACE_MS);
                String printed;
                synchronized (buffer) {
                    printed = buffer.tail();
                }
                return new Result(NO_EXIT, ToolOutput.clipTail(printed, maxOutputChars), true, null);
            }
            // After a cancel the processes the listener killed are waited for
            // as well. A command that ended on its own killed nothing, and this
            // returns at once.
            tree.awaitGone();
            drainer.join(DRAIN_GRACE_MS);
            String output;
            synchronized (buffer) {
                output = keepTail ? buffer.tail() : buffer.head();
            }
            return new Result(process.exitValue(),
                    keepTail ? ToolOutput.clipTail(output, maxOutputChars)
                            : ToolOutput.clip(output, maxOutputChars),
                    false, null);
        } catch (IOException | RuntimeException error) {
            end(process, tree);
            return new Result(NO_EXIT, "", false, error.getMessage());
        } catch (InterruptedException interrupted) {
            end(process, tree);
            Thread.currentThread().interrupt();
            return new Result(NO_EXIT, "", false, "interrupted");
        } finally {
            deregister.run();
        }
    }

    /**
     * Ends a run that failed or was interrupted: the shell and the processes
     * below it once the tree is known, the bare process when the failure came
     * before the tree.
     *
     * @param process the shell, or null when the spawn failed
     * @param tree    the shell's tree, or null when the failure came before it
     */
    private static void end(Process process, Tree tree) {
        if (tree != null) {
            tree.end();
        } else if (process != null) {
            process.destroyForcibly();
        }
    }

    /**
     * The production census: the processes below the shell, as the system
     * lists them at this moment.
     *
     * @param shell the shell's handle
     * @return the processes below it, empty once the shell is dead
     */
    private static List<ProcessHandle> below(ProcessHandle shell) {
        return shell.descendants().toList();
    }

    /**
     * The shell and the processes below it, ended on a cut (card 385).
     *
     * <p>The processes below the shell are collected while the shell still
     * holds them. Once the shell is dead they are handed to the system, and
     * {@link ProcessHandle#descendants()} of the shell finds none of them.
     * The shell is killed before them: a shell whose child dies goes on to its
     * next command, and a dead shell starts none.</p>
     *
     * <p>The census is taken once, at the cut. Two kinds of process are not
     * in it and keep running: one that a collected process starts after the
     * census and before its own kill, and one that left the tree before the
     * cut, by a double fork or {@code setsid}.</p>
     */
    private static final class Tree {
        private final Process shell;
        private final Function<ProcessHandle, List<ProcessHandle>> census;
        private List<ProcessHandle> killed = List.of();
        private boolean ended;

        /** @param shell  the {@code /bin/sh} process of one run
         *  @param census lists the processes below the shell */
        Tree(Process shell, Function<ProcessHandle, List<ProcessHandle>> census) {
            this.shell = shell;
            this.census = census;
        }

        /**
         * Kills the shell, then every process the census found below it. A
         * process started below it after the census is not reached. When the
         * census fails, the shell is killed alone: a RuntimeException from
         * the census is logged, and an Error leaves this method after the
         * kill. A shell that already ended on its own is left alone, and with
         * it whatever it left in the background. Only the first call acts.
         */
        synchronized void end() {
            if (ended || !shell.isAlive()) {
                return;
            }
            List<ProcessHandle> below = List.of();
            try {
                below = census.apply(shell.toHandle());
            } catch (RuntimeException censusFailed) {
                log.warn("could not list the processes below the shell, killing the shell alone",
                        censusFailed);
            } finally {
                shell.destroyForcibly();
                below.forEach(ProcessHandle::destroyForcibly);
                killed = below;
                ended = true;
            }
        }

        /**
         * Waits until the shell and the processes {@link #end()} killed are
         * gone, for at most {@link #REAP_GRACE_MS}. Returns at once when
         * nothing was killed.
         *
         * @throws InterruptedException when the waiting thread is interrupted
         */
        void awaitGone() throws InterruptedException {
            List<ProcessHandle> watched;
            synchronized (this) {
                if (!ended) {
                    return;
                }
                watched = killed;
            }
            long deadline = System.nanoTime() + TimeUnit.MILLISECONDS.toNanos(REAP_GRACE_MS);
            while ((shell.isAlive() || watched.stream().anyMatch(ProcessHandle::isAlive))
                    && System.nanoTime() < deadline) {
                TimeUnit.MILLISECONDS.sleep(REAP_POLL_MS);
            }
        }
    }

    /**
     * How many of a head keeping drain's bytes form the ring that keeps the end.
     *
     * <p>A finished command hands back its first {@code maxOutputChars} chars.
     * UTF-8 spends at most three bytes on one Java char (a four byte character
     * decodes to two chars), so those chars lie in the first
     * {@code 3 * maxOutputChars + 1} bytes, together with the byte after a broken
     * last sequence that tells the decoder where it ends. The buffer is four
     * bytes per char, so what is left after that head, {@code maxOutputChars - 1}
     * bytes, is the ring, and a finished command reads the same head as before
     * card 384. {@code CutCommandOutputTest} compares the two over nineteen
     * streams.</p>
     *
     * @param capBytes       the drain's buffer size
     * @param maxOutputChars the caller's char cap
     * @return the ring's size in bytes, at least one
     */
    private static int headRing(int capBytes, int maxOutputChars) {
        long head = 3L * maxOutputChars + 1;
        return (int) Math.max(1, capBytes - head);
    }

    /**
     * The drain's bounded byte sink. It never holds more than {@code cap} bytes,
     * and the reader keeps reading past the bound, which is what keeps a chatty
     * child from blocking on a full pipe.
     *
     * <p>The array fills from the front. Once it is full, each new byte
     * overwrites the oldest byte of a ring at the array's end: the whole array
     * for a caller that keeps the tail, the last {@code ringBytes} for a caller
     * that keeps the head. {@link #head()} is then what lies in front of the
     * ring, and {@link #tail()} is the ring.</p>
     */
    private static final class Sink {
        private final byte[] held;
        private final int ringStart;
        private int at;
        private int ringAt;
        private boolean overflowed;

        /** @param cap       the most bytes ever held
         *  @param ringBytes how many of them, at the end, keep the newest bytes */
        Sink(int cap, int ringBytes) {
            this.held = new byte[Math.max(1, cap)];
            this.ringStart = held.length - Math.max(1, Math.min(ringBytes, held.length));
        }

        /** Takes one chunk.
         *  @param chunk the bytes just read
         *  @param n     how many of them are real */
        void write(byte[] chunk, int n) {
            int taken = 0;
            if (at < held.length) {
                taken = Math.min(n, held.length - at);
                System.arraycopy(chunk, 0, held, at, taken);
                at += taken;
            }
            if (taken == n) {
                return;
            }
            overflowed = true;
            int ring = held.length - ringStart;
            // Only the last ring bytes of this chunk can survive it.
            for (int i = Math.max(taken, n - ring); i < n; i++) {
                held[ringStart + ringAt] = chunk[i];
                ringAt++;
                if (ringAt == ring) {
                    ringAt = 0;
                }
            }
        }

        /** The start, decoded: everything, or once the ring has been written,
         *  the bytes in front of it.
         *  @return the held head as UTF-8 */
        String head() {
            return new String(held, 0, overflowed ? ringStart : at, StandardCharsets.UTF_8);
        }

        /** The end, decoded: everything, or once older bytes were dropped, an
         *  ellipsis and the ring in the order it was written.
         *  @return the held tail as UTF-8, never starting mid-character */
        String tail() {
            if (!overflowed) {
                return new String(held, 0, at, StandardCharsets.UTF_8);
            }
            int ring = held.length - ringStart;
            byte[] out = new byte[ring];
            System.arraycopy(held, ringStart + ringAt, out, 0, ring - ringAt);
            System.arraycopy(held, ringStart, out, ring - ringAt, ringAt);
            // The cut landed anywhere, including inside a multi-byte character:
            // skip continuation bytes so the first char is not a replacement glyph.
            int from = 0;
            while (from < out.length && (out[from] & 0xC0) == 0x80) {
                from++;
            }
            return "\u2026" + new String(out, from, out.length - from, StandardCharsets.UTF_8);
        }
    }
}
