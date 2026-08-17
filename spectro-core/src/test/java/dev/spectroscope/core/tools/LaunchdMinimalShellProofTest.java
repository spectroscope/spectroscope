package dev.spectroscope.core.tools;

import org.junit.jupiter.api.Test;

import java.io.IOException;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;
import java.util.Optional;
import java.util.concurrent.TimeUnit;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.junit.jupiter.api.Assumptions.assumeTrue;

/**
 * Card 251's acceptance criterion 1, as a test: the same command in a real shell,
 * before and after the policy.
 *
 * <p>The environment is scrubbed with {@code env -i} and rebuilt as launchd's
 * default, {@code /usr/bin:/bin:/usr/sbin:/sbin} — measured 2026-08-17 off the
 * owner's live Finder-launched app rather than quoted from a blog. The "before"
 * leg is the defect: the shell reports the binary as not found. The "after" leg
 * hands the same scrubbed shell {@link ToolPath}'s answer and nothing else.
 *
 * <p>The probe binary has to be one the machine has in a toolchain directory and
 * NOT in the system floor, or the "before" leg would pass and prove nothing.
 * {@code node} is the card's own case and is tried first; the test skips where
 * no such binary exists, which is every Linux CI runner — the deterministic half
 * of the proof is ToolPathTest, which needs no machine at all.
 */
class LaunchdMinimalShellProofTest {

    /** launchd's default for a GUI app — what the owner's app really carried. */
    private static final String LAUNCHD = "/usr/bin:/bin:/usr/sbin:/sbin";

    /** Candidates in the order they are tried; the card's symptom leads. */
    private static final List<String> PROBES = List.of("node", "npm", "git-lfs", "rg", "jq");

    @Test
    void aToolchainBinaryIsInvisibleUnderLaunchdsPathAndVisibleUnderThePolicy() throws Exception {
        Optional<String> probe = PROBES.stream().filter(LaunchdMinimalShellProofTest::onlyInToolchain)
                .findFirst();
        assumeTrue(probe.isPresent(),
                "no binary that exists in a toolchain dir and not in the system floor");
        String binary = probe.get();

        Shell before = runScrubbed(LAUNCHD, "command -v " + binary);
        assertNotEquals(0, before.exitCode(),
                "the defect is gone from this machine, so the proof proves nothing: "
                        + binary + " resolved under " + LAUNCHD + " as " + before.output());

        String enriched = ToolPath.resolve(LAUNCHD,
                Path.of(System.getProperty("user.home", "")), Files::isDirectory).path();
        Shell after = runScrubbed(enriched, "command -v " + binary);
        assertEquals(0, after.exitCode(),
                "the policy must make " + binary + " resolvable; PATH was " + enriched);
        assertTrue(after.output().endsWith("/" + binary),
                "expected a path to " + binary + ", got " + after.output());
    }

    @Test
    void thePolicyDoesNotCostTheScrubbedShellItsOwnFloor() throws Exception {
        String enriched = ToolPath.resolve(LAUNCHD,
                Path.of(System.getProperty("user.home", "")), Files::isDirectory).path();

        Shell result = runScrubbed(enriched, "uname -s");

        assertEquals(0, result.exitCode(), result.output());
    }

    /** What one scrubbed shell run produced.
     *  @param exitCode the shell's exit status
     *  @param output   stdout and stderr merged, trimmed */
    private record Shell(int exitCode, String output) {
    }

    /**
     * Runs one command in a shell whose entire environment is PATH and nothing
     * else. {@code env -i} is the only way to reach the Finder case from a test:
     * the JVM's own environment cannot be unset from inside it.
     *
     * @param path    the PATH the shell gets
     * @param command the shell line
     * @return exit code and merged output
     * @throws IOException          when the spawn itself fails
     * @throws InterruptedException when the wait is interrupted
     */
    private static Shell runScrubbed(String path, String command)
            throws IOException, InterruptedException {
        ProcessBuilder builder = new ProcessBuilder("/usr/bin/env", "-i", "PATH=" + path,
                "/bin/sh", "-c", command).redirectErrorStream(true);
        Process process = builder.start();
        String output;
        try (InputStream in = process.getInputStream()) {
            output = new String(in.readAllBytes(), StandardCharsets.UTF_8).trim();
        }
        assertTrue(process.waitFor(30, TimeUnit.SECONDS), "the scrubbed shell hung");
        return new Shell(process.exitValue(), output);
    }

    /**
     * True when the binary exists in one of the policy's toolchain directories and
     * in none of the system floor ones — the shape that makes the "before" leg fail.
     *
     * @param binary the command name to look for
     * @return true when it is a usable probe on this machine
     */
    private static boolean onlyInToolchain(String binary) {
        boolean inFloor = ToolPath.SYSTEM_FLOOR.stream()
                .anyMatch(dir -> Files.isExecutable(Path.of(dir, binary)));
        boolean inToolchain = ToolPath.TOOLCHAIN_DIRS.stream()
                .anyMatch(dir -> Files.isExecutable(Path.of(dir, binary)));
        return inToolchain && !inFloor;
    }
}
