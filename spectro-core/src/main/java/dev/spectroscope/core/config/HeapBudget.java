package dev.spectroscope.core.config;

import java.lang.management.ManagementFactory;
import java.util.Locale;
import java.util.Optional;

/**
 * How much room the JVM gave this process, in one sentence a support thread can
 * quote, plus the one condition worth a warning.
 *
 * <h2>Why a percentage and not a number</h2>
 * The JVM sizes its own heap at {@code MaxRAMPercentage}, which defaults to 25.
 * On a 48 GiB workstation that is 12 GiB; on an 8 GiB laptop it is 2 GiB. Both
 * are sane, because the shape scales. A literal destroys that property in both
 * directions at once: {@code -Xmx8g} would be a cut on the workstation, and on
 * the laptop it would be a promise the machine cannot keep, paid for in swap or
 * in an OOM kill that leaves no error the UI can show. So the raise is expressed
 * as {@link #MAX_RAM_PERCENT}, a third of whatever machine or container the
 * process finds itself in. Container support is on by default, so inside a
 * cgroup the third is a third of the cgroup limit, not of the host.
 *
 * <h2>Where the floor comes from</h2>
 * Measured, on real transcripts. A single import of a 47 MB session needs
 * between 256m and 384m to complete; three concurrent ones need between 768m and
 * 1g. The expansion is roughly eightfold because the read holds the whole file
 * as a UTF-16 String and then copies it into the response. The transcript
 * endpoint refuses anything over its own cap, so that cap, times the expansion,
 * is the smallest heap on which the worst allowed import can still finish. Raise
 * the cap and this floor rises with it, which is the point: the cap is the heap
 * budget, not a politeness limit.
 *
 * <h2>What a bigger ceiling does not buy</h2>
 * The same three concurrent imports peaked at 2.65 GB used against the 12 GiB
 * default and at 1.46 GB under {@code -Xmx2g}, returned the same bytes at the
 * same speed, and held 18 MB live once collected. Nearly all of that peak was
 * garbage G1 had no reason to collect. A ceiling is therefore cheap but not
 * free: it is a licence for the collector to be lazy, which shows up as resident
 * memory on a small machine. That is the second reason for a third rather than a
 * half.
 *
 * @param maxHeapBytes  the ceiling this JVM will actually honour
 * @param physicalBytes the machine or container size, or 0 when unknown
 * @param importCapBytes the largest transcript the server will read into heap
 */
public record HeapBudget(long maxHeapBytes, long physicalBytes, long importCapBytes) {

    /**
     * The share of the machine every launch path we control hands the JVM. A
     * third: 15.8 GiB on a 48 GiB workstation, 5.3 on a 16 GiB laptop, 2.6 on an
     * 8 GiB one, 1.3 on a 4 GiB box. Every one of those is more than the 25% the
     * same machine gets today, which is the property a literal cannot have.
     */
    public static final int MAX_RAM_PERCENT = 33;

    /** The exact flag. {@code HeapFlagDriftTest} holds the launch paths to it. */
    public static final String FLAG = "-XX:MaxRAMPercentage=" + MAX_RAM_PERCENT;

    /**
     * The cap {@code ClaudeTranscriptsController} refuses transcripts above,
     * mirrored here because core cannot see into the server module and the floor
     * is a function of it. The mirror is not on trust: {@code HeapFlagDriftTest}
     * reads the controller's source and fails when the two drift apart.
     */
    public static final long TRANSCRIPT_IMPORT_CAP_BYTES = 64L * 1024 * 1024;

    /** Measured heap per byte of transcript: UTF-16 blowup plus the response copy. */
    private static final int IMPORT_EXPANSION = 8;

    private static final long MIB = 1L << 20;
    private static final long GIB = 1L << 30;

    /**
     * Guards the invariants the formatting below relies on.
     */
    public HeapBudget {
        if (maxHeapBytes <= 0) {
            throw new IllegalArgumentException("maxHeapBytes must be positive: " + maxHeapBytes);
        }
        if (physicalBytes < 0) {
            throw new IllegalArgumentException("physicalBytes must not be negative: " + physicalBytes);
        }
        if (importCapBytes <= 0) {
            throw new IllegalArgumentException("importCapBytes must be positive: " + importCapBytes);
        }
    }

    /**
     * The running process against the cap the server actually enforces.
     *
     * @return the budget for the running process
     */
    public static HeapBudget measure() {
        return measure(TRANSCRIPT_IMPORT_CAP_BYTES);
    }

    /**
     * Reads this JVM's real ceiling and, when the JDK extension is present, the
     * machine size. Never throws: it is called from {@code main} before anything
     * else, and a diagnostic must not be the reason a server refuses to start.
     *
     * @param importCapBytes the transcript endpoint's cap
     * @return the budget for the running process
     */
    public static HeapBudget measure(long importCapBytes) {
        long physical = 0L;
        try {
            java.lang.management.OperatingSystemMXBean os = ManagementFactory.getOperatingSystemMXBean();
            if (os instanceof com.sun.management.OperatingSystemMXBean sun) {
                physical = Math.max(0L, sun.getTotalMemorySize());
            }
        } catch (Throwable notOnThisRuntime) {
            // A jlink image without jdk.management, or a future JDK that moved
            // the accessor. The line below still answers the ceiling question.
            physical = 0L;
        }
        return new HeapBudget(Runtime.getRuntime().maxMemory(), physical, importCapBytes);
    }

    /**
     * The smallest heap on which one worst-case import can still complete.
     *
     * @return the cap times the measured expansion factor
     */
    public long floorBytes() {
        return importCapBytes * IMPORT_EXPANSION;
    }

    /**
     * One line, logged at boot on every launch path including the bare
     * {@code java -jar} one no build script can reach. The share is the part
     * that matters operationally: 25% means no launcher passed anything.
     *
     * @return the ceiling, the machine it is a share of, and the import cap
     */
    public String line() {
        String head = "heap: max " + human(maxHeapBytes);
        if (physicalBytes > 0) {
            long share = Math.round(100.0 * maxHeapBytes / physicalBytes);
            head += " of a " + human(physicalBytes) + " machine (" + share + "%)";
        }
        return head + ", transcript import cap " + human(importCapBytes);
    }

    /**
     * The one condition worth interrupting someone for: a ceiling under the
     * floor, which is what a fixed {@code -Xmx} or a tight container limit
     * produces. Silent on every machine that can run this product at all.
     *
     * @return the warning with the fix in it, or empty when there is room
     */
    public Optional<String> warning() {
        if (maxHeapBytes >= floorBytes()) {
            return Optional.empty();
        }
        return Optional.of("heap: max " + human(maxHeapBytes) + " is under the " + human(floorBytes())
                + " one transcript import at the " + human(importCapBytes) + " cap needs. Pass "
                + FLAG + ", or give the container more memory.");
    }

    /**
     * Byte sizes the way a human reads them, in the binary units the JVM itself
     * reports so a reader can check the number against {@code -XX:+PrintFlagsFinal}.
     *
     * @param bytes the size to render
     * @return "15.8 GiB" at a gibibyte and above, "512 MiB" below it
     */
    private static String human(long bytes) {
        if (bytes >= GIB) {
            return String.format(Locale.ROOT, "%.1f GiB", bytes / (double) GIB);
        }
        return (bytes / MIB) + " MiB";
    }
}
