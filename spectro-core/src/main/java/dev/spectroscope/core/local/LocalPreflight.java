package dev.spectroscope.core.local;

import dev.spectroscope.core.config.governing.Governs;

import java.lang.management.ManagementFactory;
import java.nio.file.Files;
import java.nio.file.Path;

/**
 * Asks the machine whether it can hold a model before a multi-gigabyte download
 * starts. A pure fold over three numbers ({@link #check}) so the answer is
 * testable without filling a disk; {@link #onThisMachine} reads the real ones.
 *
 * <p>Two deliberate softnesses. A machine whose numbers the JVM cannot read is
 * reported as unknown rather than refused, because inventing a refusal is worse
 * than letting an operator try. And a fit that only just works is allowed but
 * marked tight, so the face can warn instead of blocking.</p>
 */
public final class LocalPreflight {

    private LocalPreflight() {
    }

    /** Free disk must exceed the download by this much, since the {@code .part}
     *  file and its atomic move briefly share the volume with everything else. */
    @Governs(kind = Governs.Kind.FIXED, unit = Governs.Unit.RATIO)
    private static final double DISK_HEADROOM = 1.25;

    /** Below this multiple of the recommended memory the fit is called tight. */
    @Governs(kind = Governs.Kind.FIXED, unit = Governs.Unit.RATIO)
    private static final double TIGHT_RAM = 1.25;

    /**
     * What the machine can promise about one model.
     *
     * @param ok               whether the download and run may proceed
     * @param tight            whether it fits with little to spare
     * @param known            whether the machine's numbers could be read at all
     * @param diskOk           whether free space covers the download plus headroom
     * @param ramOk            whether total memory covers the recommendation
     * @param diskNeededBytes  free space the download wants
     * @param diskFreeBytes    free space the volume reports, or 0 when unknown
     * @param ramNeededBytes   total memory the model wants
     * @param ramTotalBytes    total memory the machine reports, or 0 when unknown
     */
    public record Verdict(boolean ok, boolean tight, boolean known,
                          boolean diskOk, boolean ramOk,
                          long diskNeededBytes, long diskFreeBytes,
                          long ramNeededBytes, long ramTotalBytes) {
    }

    /**
     * The pure check.
     *
     * @param model          the catalogue entry being considered
     * @param totalRamBytes  total system memory, or 0 when it could not be read
     * @param usableDiskBytes free space on the models volume, or 0 when unknown
     * @return the verdict, never null
     */
    public static Verdict check(LocalCatalog.Model model, long totalRamBytes, long usableDiskBytes) {
        long diskNeeded = Math.round(model.sizeBytes() * DISK_HEADROOM);
        long ramNeeded = model.minRamBytes();
        boolean diskKnown = usableDiskBytes > 0;
        boolean ramKnown = totalRamBytes > 0;
        boolean known = diskKnown || ramKnown;

        boolean diskOk = !diskKnown || usableDiskBytes >= diskNeeded;
        boolean ramOk = !ramKnown || totalRamBytes >= ramNeeded;
        boolean tight = ramKnown && ramOk && totalRamBytes < ramNeeded * TIGHT_RAM;

        return new Verdict(diskOk && ramOk, tight, known, diskOk, ramOk,
                diskNeeded, usableDiskBytes, ramNeeded, totalRamBytes);
    }

    /**
     * The same check against this machine's real numbers.
     *
     * @param model     the catalogue entry being considered
     * @param modelsDir where the download would land, used to pick the volume
     * @return the verdict, never null
     */
    public static Verdict onThisMachine(LocalCatalog.Model model, Path modelsDir) {
        return check(model, totalMemoryBytes(), usableSpaceBytes(modelsDir));
    }

    /** @return total physical memory, or 0 when this JVM cannot say */
    public static long totalMemoryBytes() {
        try {
            java.lang.management.OperatingSystemMXBean os = ManagementFactory.getOperatingSystemMXBean();
            if (os instanceof com.sun.management.OperatingSystemMXBean sun) {
                return sun.getTotalMemorySize();
            }
        } catch (RuntimeException | LinkageError unavailable) {
            // a JVM without the com.sun extension: report unknown rather than guess
        }
        return 0;
    }

    /**
     * Free space on the volume that would hold the download. Walks up to the
     * nearest existing parent, because {@code ~/.spectro/models} may not exist
     * yet on a first run.
     *
     * @param modelsDir the intended download directory
     * @return usable bytes, or 0 when the volume cannot be read
     */
    public static long usableSpaceBytes(Path modelsDir) {
        Path probe = modelsDir == null ? null : modelsDir.toAbsolutePath();
        while (probe != null && !Files.exists(probe)) {
            probe = probe.getParent();
        }
        if (probe == null) {
            return 0;
        }
        try {
            return Files.getFileStore(probe).getUsableSpace();
        } catch (Exception unreadable) {
            return 0;
        }
    }
}
