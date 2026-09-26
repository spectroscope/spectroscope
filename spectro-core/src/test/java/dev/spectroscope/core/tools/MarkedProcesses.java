package dev.spectroscope.core.tools;

import java.util.Arrays;
import java.util.List;
import java.util.concurrent.ThreadLocalRandom;
import java.util.concurrent.TimeUnit;

/**
 * Counts a test's processes from outside, by a marker in their command line
 * (card 385, criterion 4).
 *
 * <p>A test puts a fresh marker into its command, as a sleep length and, where
 * a pipe needs a reader, as the reader's argument. This class then walks
 * {@link ProcessHandle#allProcesses()} and keeps every process whose command
 * line carries the marker as a whole word. It never asks the killed shell for
 * its {@link ProcessHandle#descendants()}: once the shell is dead, its
 * children belong to the system and that call finds none of them, whether
 * they still run or not.</p>
 */
public final class MarkedProcesses {

    /** How often the census is taken again while a test waits on it. */
    private static final long POLL_MS = 20;

    /** Static utility, no instances. */
    private MarkedProcesses() {
    }

    /**
     * A marker no running process carries. It is a number of seconds between
     * one and two weeks, so it works as a sleep length, and a sleeper that
     * slipped every clean up still ends on its own.
     *
     * @return the marker, as the decimal text the command will carry
     */
    public static String fresh() {
        while (true) {
            String marker = Long.toString(ThreadLocalRandom.current().nextLong(604_800, 1_209_600));
            if (alive(marker).isEmpty()) {
                return marker;
            }
        }
    }

    /**
     * Every live process whose command line carries the marker as a whole word.
     *
     * @param marker the test's marker
     * @return the processes, in the order the system listed them
     */
    public static List<ProcessHandle> alive(String marker) {
        long self = ProcessHandle.current().pid();
        return ProcessHandle.allProcesses()
                .filter(handle -> handle.pid() != self)
                .filter(handle -> handle.info().commandLine()
                        .map(line -> Arrays.asList(line.split("\\s+")).contains(marker))
                        .orElse(false))
                .toList();
    }

    /**
     * Waits until a process of each named program carries the marker, so a cut
     * made after this call meets the tree whole.
     *
     * @param marker    the test's marker
     * @param timeoutMs the longest wait
     * @param programs  the file names of the programs to wait for, such as
     *                  {@code sleep} or {@code grep}
     * @return true when all of them were seen before the time ran out
     * @throws InterruptedException when the waiting thread is interrupted
     */
    public static boolean awaitRunning(String marker, long timeoutMs, String... programs)
            throws InterruptedException {
        long deadline = System.nanoTime() + TimeUnit.MILLISECONDS.toNanos(timeoutMs);
        while (System.nanoTime() < deadline) {
            List<ProcessHandle> live = alive(marker);
            boolean all = Arrays.stream(programs).allMatch(program -> live.stream()
                    .anyMatch(handle -> handle.info().command()
                            .map(command -> command.endsWith("/" + program))
                            .orElse(false)));
            if (all) {
                return true;
            }
            TimeUnit.MILLISECONDS.sleep(POLL_MS);
        }
        return false;
    }

    /**
     * The processes that still carry the marker once the grace is over. The
     * census is taken again until none is left or the grace has passed.
     *
     * @param marker  the test's marker
     * @param graceMs how long the processes are given to be gone
     * @return the survivors, empty when none is left
     * @throws InterruptedException when the waiting thread is interrupted
     */
    public static List<ProcessHandle> survivorsAfter(String marker, long graceMs)
            throws InterruptedException {
        long deadline = System.nanoTime() + TimeUnit.MILLISECONDS.toNanos(graceMs);
        List<ProcessHandle> live = alive(marker);
        while (!live.isEmpty() && System.nanoTime() < deadline) {
            TimeUnit.MILLISECONDS.sleep(POLL_MS);
            live = alive(marker);
        }
        return live;
    }

    /**
     * Waits until no process that carries the marker has the given pid.
     *
     * @param marker  the test's marker
     * @param pid     the process to wait for
     * @param graceMs how long it is given to be gone
     * @return true when it was gone before the grace ran out
     * @throws InterruptedException when the waiting thread is interrupted
     */
    public static boolean goneWithin(String marker, long pid, long graceMs)
            throws InterruptedException {
        long deadline = System.nanoTime() + TimeUnit.MILLISECONDS.toNanos(graceMs);
        while (alive(marker).stream().anyMatch(handle -> handle.pid() == pid)) {
            if (System.nanoTime() >= deadline) {
                return false;
            }
            TimeUnit.MILLISECONDS.sleep(POLL_MS);
        }
        return true;
    }

    /**
     * Ends every process that carries the marker. A test calls it when it is
     * done, so a leak it found does not keep running on the machine. No
     * process carried the marker when {@link #fresh()} drew it.
     *
     * @param marker the test's marker
     */
    public static void reap(String marker) {
        alive(marker).forEach(ProcessHandle::destroyForcibly);
    }

    /**
     * The survivors as one line each, for an assertion message.
     *
     * @param survivors the processes still alive
     * @return their pids and command lines
     */
    public static String describe(List<ProcessHandle> survivors) {
        return survivors.stream()
                .map(handle -> handle.pid() + " " + handle.info().commandLine().orElse("?"))
                .toList()
                .toString();
    }
}
