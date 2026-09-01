package dev.spectroscope.core.config;

import dev.spectroscope.core.config.governing.Governs;

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
 * Measured, on real transcripts, and no longer derived from anything. It used to
 * be the transcript cap times eight, because the import read answered with
 * {@code Files.readString}: one request held the whole file as a UTF-16 String
 * and then copied it into the response, so the cap really was this process's
 * heap budget. The endpoint streams now. Its cost is a buffer, three concurrent
 * reads of the largest transcript in the real store complete on {@code -Xmx128m},
 * and the floor stopped moving with the cap. See {@link #FLOOR_BYTES} for the
 * measurement and {@link #floorBytes()} for what it is independent of.
 *
 * <p>So raising the transcript cap raises what the BROWSER must survive, not
 * what this process must hold. Whoever changes {@code MAX_CONTENT_BYTES} does
 * not need to change the floor with it.
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
 * @param importCapBytes the largest transcript the server will serve, reported
 *                       by {@link #line()} as an operational fact; it is not a
 *                       heap input, because the read is streamed
 */
public record HeapBudget(long maxHeapBytes, long physicalBytes, long importCapBytes) {

    /**
     * The share of the machine every launch path we control hands the JVM. A
     * third: 15.8 GiB on a 48 GiB workstation, 5.3 on a 16 GiB laptop, 2.6 on an
     * 8 GiB one, 1.3 on a 4 GiB box. Every one of those is more than the 25% the
     * same machine gets today, which is the property a literal cannot have.
     */
    @Governs(kind = Governs.Kind.FIXED, unit = Governs.Unit.PERCENT)
    public static final int MAX_RAM_PERCENT = 33;

    /** The exact flag. {@code HeapFlagDriftTest} holds the launch paths to it. */
    public static final String FLAG = "-XX:MaxRAMPercentage=" + MAX_RAM_PERCENT;

    /**
     * The cap {@code ClaudeTranscriptsController} refuses transcripts above,
     * mirrored here because {@link #line()} reports it at boot and core cannot
     * see into the server module to read it. It is reported, not computed with:
     * {@link #floorBytes()} ignores it, and this mirror once justified itself by
     * saying the floor was a function of it, which was true of the read that
     * held the file in heap and false from the moment that read was streamed.
     * The mirror is not on trust: {@code HeapFlagDriftTest} reads the
     * controller's source and fails when the two drift apart.
     */
    @Governs(kind = Governs.Kind.FIXED, unit = Governs.Unit.BYTES)
    public static final long TRANSCRIPT_IMPORT_CAP_BYTES = 128L * 1024 * 1024;

    /**
     * The smallest heap on which the server's import path still works, measured
     * rather than derived from the cap.
     *
     * <p>It used to be the cap times eight, because {@code content()} answered
     * with {@code Files.readString}: the whole transcript as a UTF-16 String plus
     * the response copy. A unit test now measures that doubling directly, at
     * 50,334,944 bytes of thread allocation for a 25,165,818 byte file, and the
     * endpoint no longer does it. It streams the file to the socket, so its heap
     * cost is a buffer and no longer scales with the file at all.
     *
     * <p>Measured 2026-08-03 against the 0.5.0 jar with {@code -Xmx128m} over the
     * real store: the 73.6 MiB transcript served byte-identically in 126 ms, the
     * 82.9 MiB one in 175 ms, and three concurrent reads of the 82.9 MiB one each
     * returned all 86,913,996 bytes with no OutOfMemoryError. 256 MiB is that
     * proven-working ceiling doubled, because the experiment exercised the import
     * path alone and a real server also holds sessions, sockets and the fleet
     * aggregator.
     */
    @Governs(kind = Governs.Kind.FIXED, unit = Governs.Unit.BYTES)
    private static final long FLOOR_BYTES = 256L * 1024 * 1024;

    /** A mebibyte. A unit conversion and not a limit: the value is
     *  arithmetic, so changing it does not change what a run may do. */
    @Governs(kind = Governs.Kind.PLUMBING, unit = Governs.Unit.NONE)
    private static final long MIB = 1L << 20;

    /** A gibibyte. A unit conversion and not a limit, like {@link #MIB}. */
    @Governs(kind = Governs.Kind.PLUMBING, unit = Governs.Unit.NONE)
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
     * The smallest heap on which the server's import path still works.
     *
     * <p>Independent of {@link #importCapBytes} on purpose: the read is streamed,
     * so raising the cap raises what the BROWSER must survive, not what this
     * process must hold.
     *
     * @return the measured floor
     */
    public long floorBytes() {
        return FLOOR_BYTES;
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
     * <p>The sentence names the floor and not the transcript cap. It used to
     * name both, which was true at the shipped cap and implied a derivation the
     * streamed read deleted: lowering the cap would not move the number, so a
     * reader who acted on the sentence would change the wrong thing.</p>
     *
     * @return the warning with the fix in it, or empty when there is room
     */
    public Optional<String> warning() {
        if (maxHeapBytes >= floorBytes()) {
            return Optional.empty();
        }
        return Optional.of("heap: max " + human(maxHeapBytes) + " is under the measured "
                + human(floorBytes()) + " this server's working set needs. Pass "
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
