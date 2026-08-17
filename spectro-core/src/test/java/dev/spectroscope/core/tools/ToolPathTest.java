package dev.spectroscope.core.tools;

import org.junit.jupiter.api.Test;

import java.nio.file.Path;
import java.util.List;
import java.util.Set;
import java.util.function.Predicate;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * Card 251: the PATH policy, driven through its pure seam because a test cannot
 * scrub the JVM's own environment.
 *
 * <p>The two fixtures are the two real cases, both measured on 2026-08-17.
 * {@link #LAUNCHD} is what the owner's Finder-launched app actually carried
 * ({@code ps eww} on the live server JVM). {@link #TERMINAL} is the shape a
 * login shell exports, duplicate entry included — the owner's PATH names
 * {@code /opt/homebrew/bin} twice, and a policy that "tidies" that would change
 * a PATH it was asked to leave alone.
 */
class ToolPathTest {

    /** The measured Finder case: launchd's default, four directories. */
    private static final String LAUNCHD = "/usr/bin:/bin:/usr/sbin:/sbin";

    /** The terminal case: everything this policy knows about, already exported. */
    private static final String TERMINAL = "/opt/homebrew/bin:/Users/x/.local/bin"
            + ":/opt/homebrew/bin:/opt/homebrew/sbin:/usr/local/bin:/usr/local/sbin"
            + ":/usr/bin:/bin:/usr/sbin:/sbin";

    private static final Path HOME = Path.of("/Users/x");

    /** Every directory exists — the machine with a full toolchain. */
    private static final Predicate<Path> ALL_EXIST = path -> true;

    /**
     * A machine where only the named directories exist.
     *
     * @param present the directories that exist
     * @return an existence predicate over exactly those
     */
    private static Predicate<Path> only(String... present) {
        Set<String> set = Set.of(present);
        return path -> set.contains(path.toString());
    }

    @Test
    void theFinderCaseGetsTheToolchainDirectoriesInFrontOfTheSystemFloor() {
        ToolPath.Result result = ToolPath.resolve(LAUNCHD, HOME, ALL_EXIST);

        assertTrue(result.path().startsWith("/opt/homebrew/bin:"),
                "homebrew must lead so the agent resolves the owner's binary: " + result.path());
        assertTrue(result.path().indexOf("/usr/local/bin") < result.path().indexOf("/usr/bin"),
                "a package-manager prefix must beat the system floor: " + result.path());
        assertTrue(result.path().endsWith(LAUNCHD),
                "the inherited PATH stays verbatim at the end: " + result.path());
    }

    @Test
    void theFinderCaseCanFindTheOwnersHomebrewNode() {
        // The card's own symptom, as a path question: /opt/homebrew/bin/node was
        // invisible to the agent while the terminal ran it.
        ToolPath.Result result = ToolPath.resolve(LAUNCHD, HOME, ALL_EXIST);

        assertTrue(List.of(result.path().split(":")).contains("/opt/homebrew/bin"),
                "the directory holding the owner's node must be on the PATH: " + result.path());
    }

    @Test
    void aTerminalPathThatAlreadyCarriesThemIsReturnedUnchanged() {
        // The no-divergence pin: from a shell that already exports these, the
        // policy is a no-op down to the byte, duplicate entry included.
        ToolPath.Result result = ToolPath.resolve(TERMINAL, HOME, ALL_EXIST);

        assertEquals(TERMINAL, result.path(), "a terminal launch must be untouched");
        assertEquals(List.of(), result.added(), "nothing to add means nothing added");
    }

    @Test
    void aDirectoryThatDoesNotExistIsNeverAdded() {
        // An Intel-prefix-only machine must not get an /opt/homebrew that isn't there:
        // a phantom entry makes every lookup in it a wasted syscall and a lie in doctor.
        ToolPath.Result result = ToolPath.resolve(LAUNCHD, HOME,
                only("/usr/local/bin", "/usr/bin", "/bin", "/usr/sbin", "/sbin"));

        assertFalse(result.path().contains("/opt/homebrew"),
                "a missing prefix must not appear: " + result.path());
        assertEquals(List.of("/usr/local/bin"), result.added());
    }

    @Test
    void thePerUserBinaryDirectoryResolvesAgainstTheGivenHome() {
        ToolPath.Result result = ToolPath.resolve(LAUNCHD, Path.of("/Users/zoe"), ALL_EXIST);

        assertTrue(result.path().contains("/Users/zoe/.local/bin"),
                "pipx and uv install into the user's own bin dir: " + result.path());
    }

    @Test
    void aHomeThatIsNotAbsoluteContributesNothing() {
        // The fresh-user tests start JVMs with an empty -Duser.home; a relative
        // PATH entry would then point wherever the tool happens to be running.
        ToolPath.Result result = ToolPath.resolve(LAUNCHD, Path.of(""), ALL_EXIST);

        for (String entry : result.path().split(":")) {
            assertTrue(entry.startsWith("/"), "a relative PATH entry slipped in: " + entry);
        }
    }

    @Test
    void anEmptyInheritedPathStillYieldsAUsableShell() {
        // A blank PATH is not hypothetical: a caller that scrubs the environment
        // (and every `env -i` child) hands us exactly this.
        ToolPath.Result result = ToolPath.resolve("", HOME, ALL_EXIST);

        for (String floor : ToolPath.SYSTEM_FLOOR) {
            assertTrue(List.of(result.path().split(":")).contains(floor),
                    floor + " must be there so sh, ls and git resolve: " + result.path());
        }
    }

    @Test
    void aNullInheritedPathIsTreatedAsEmptyRatherThanCrashing() {
        ToolPath.Result result = ToolPath.resolve(null, HOME, ALL_EXIST);

        assertTrue(result.path().contains("/usr/bin"), result.path());
        assertFalse(result.path().contains("null"), result.path());
    }

    @Test
    void aTrailingSlashCountsAsThePresentDirectory() {
        ToolPath.Result result = ToolPath.resolve("/opt/homebrew/bin/:" + LAUNCHD, HOME, ALL_EXIST);

        assertFalse(result.added().contains("/opt/homebrew/bin"),
                "the same directory written with a slash is not missing: " + result.added());
    }

    @Test
    void theSystemFloorIsAppendedNotPrepended() {
        // Order is the whole point: prepending the floor to a PATH that lacks it
        // would put /usr/bin ahead of the caller's own entries.
        ToolPath.Result result = ToolPath.resolve("/opt/homebrew/bin", HOME,
                only("/opt/homebrew/bin", "/usr/bin", "/bin", "/usr/sbin", "/sbin"));

        assertTrue(result.path().startsWith("/opt/homebrew/bin:/usr/bin"),
                "the inherited entry keeps the front: " + result.path());
    }

    @Test
    void addedNamesExactlyWhatThePolicyContributed() {
        // Doctor prints this list; a wrong list is a doctor that lies about the
        // one fact the operator came for.
        ToolPath.Result result = ToolPath.resolve(LAUNCHD, HOME, ALL_EXIST);

        assertEquals(List.of("/opt/homebrew/bin", "/opt/homebrew/sbin", "/usr/local/bin",
                "/usr/local/sbin", "/Users/x/.local/bin"), result.added());
        for (String added : result.added()) {
            assertTrue(List.of(result.path().split(":")).contains(added),
                    added + " is claimed but not on the PATH: " + result.path());
        }
    }

    @Test
    void noDirectoryAppearsTwiceBecauseOfThePolicy() {
        ToolPath.Result result = ToolPath.resolve(LAUNCHD, HOME, ALL_EXIST);

        List<String> entries = List.of(result.path().split(":"));
        for (String added : result.added()) {
            assertEquals(1, entries.stream().filter(added::equals).count(),
                    added + " was added on top of an entry that was already there: " + result.path());
        }
    }

    @Test
    void thisJvmGetsAPathThatAtLeastCarriesTheSystemFloor() {
        // The live entry point, without asserting anything machine-specific.
        ToolPath.Result result = ToolPath.resolve();

        assertTrue(result.path().contains("/usr/bin") || result.path().contains("/bin"),
                "the resolved PATH must be usable on any host: " + result.path());
    }
}
