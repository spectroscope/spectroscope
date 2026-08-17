package dev.spectroscope.core.tools;

import java.io.File;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Set;
import java.util.function.Predicate;

/**
 * The PATH every tool shell gets — one deliberate policy, decided in the process
 * that spawns the shell.
 *
 * <p>Measured 2026-08-17 on the owner's own running app, launched from Finder,
 * read off the live processes rather than assumed
 * ({@code ps eww -p <pid> -o command | tr ' ' '\n' | grep ^PATH=}): both the
 * Electron main and the server JVM it spawns carry
 * {@code PATH=/usr/bin:/bin:/usr/sbin:/sbin}, and {@code launchctl getenv PATH}
 * answers empty — a GUI app gets launchd's default, and the desktop shell hands
 * the JVM no environment of its own. {@code run_command} inherits those four
 * directories. The owner's {@code node} is {@code /opt/homebrew/bin/node},
 * v25.9.0, in none of them: the agent got exit 127 and reported "no node
 * binary" while the terminal in the same directory printed a version.
 *
 * <p><b>The policy.</b> The inherited PATH is kept verbatim; the well-known
 * toolchain directories that EXIST and are not already on it are prepended, and
 * the system floor is appended for the same reason. Two properties follow from
 * that shape, and both are pinned in ToolPathTest:
 *
 * <ul>
 *   <li>Launched from a terminal that already exports these directories, the
 *       result is the inherited string unchanged — the CLI-launched and the
 *       Finder-launched app resolve the same set in the same order, which is
 *       the card's "no silent divergence" in one sentence.</li>
 *   <li>Launched from Finder, homebrew lands BEFORE {@code /usr/bin}, which is
 *       where a login shell puts it. Appending instead would let a system copy
 *       of a tool win over the owner's — the agent would then run a DIFFERENT
 *       binary than the terminal, which is worse than not finding one.</li>
 * </ul>
 *
 * <p><b>The trade-off, stated because the alternative is tempting.</b> Capturing
 * the login shell's PATH once at startup
 * ({@code $SHELL -l -i -c 'printf %s "$PATH"'}) would find everything the owner
 * has, version-manager shims included. It also runs the owner's rc files inside
 * the app, at a latency nobody controls (an rc file that prompts, hangs or
 * greps a network mount hangs the capture), and yields a PATH that differs by
 * shell, by rc state and by day. This list is deterministic and testable where
 * that is neither, so this list wins. The gap it leaves is named below rather
 * than hidden.
 *
 * <p><b>What this refuses to guess.</b> Version-manager shims:
 * {@code ~/.nvm/versions/node/<v>/bin} and the pyenv/rbenv/asdf equivalents
 * exist once per installed version, and choosing one behind the owner's back
 * would silently give the agent a different toolchain than the terminal. An
 * honest "command not found" beats a quiet wrong answer, so doctor prints the
 * effective PATH instead and the gap becomes a lookup. An environment variable
 * could not serve as the operator's lever either: launchd hands a GUI app no
 * shell environment, so a {@code SPECTRO_PATH_EXTRA} would work only from a
 * terminal — the case that needs it least. If a lever is ever wanted it belongs
 * in settings.json, which is an owner call and not something to invent here.
 *
 * <p><b>Where this is applied, and where it is not.</b> {@link ShellCommand}
 * sets it on every child it spawns, which is {@code run_command} and every
 * hook, and {@code spectro doctor} prints it. Other PATH readers still read the
 * raw environment: {@code LlamaServerBinary}, {@code BrowsePageTool}'s Chrome
 * search, and {@code DockerPing}, which solved this same launchd problem for
 * itself in 0.5.0 with its own well-known-directory list. The interactive
 * terminal is not affected either way — it spawns a login shell ({@code -l -i}),
 * so it has always rebuilt PATH from the owner's rc files.
 */
public final class ToolPath {

    /**
     * Package-manager prefixes, in resolution order: Apple-silicon homebrew
     * first (the machine this was measured on), then the Intel/hand-built
     * prefix. {@code sbin} is included because homebrew installs there too.
     */
    static final List<String> TOOLCHAIN_DIRS = List.of(
            "/opt/homebrew/bin", "/opt/homebrew/sbin", "/usr/local/bin", "/usr/local/sbin");

    /**
     * Per-user binary directories, relative to the home directory. {@code pipx},
     * {@code uv} and {@code pip --user} install here, and it is on the owner's
     * own PATH — a directory a login shell exports is exactly the kind this
     * policy is for.
     */
    static final List<String> HOME_TOOLCHAIN_DIRS = List.of(".local/bin");

    /**
     * launchd's default for a GUI app, appended rather than prepended: these are
     * the four the Finder case already has, so the append only matters when a
     * caller hands us a PATH that is empty or exotic — then a tool shell still
     * finds {@code sh}, {@code ls} and {@code git} instead of failing at
     * everything.
     */
    static final List<String> SYSTEM_FLOOR = List.of("/usr/bin", "/bin", "/usr/sbin", "/sbin");

    /**
     * The effective PATH plus the provenance doctor prints.
     *
     * @param path  the value to hand a tool shell
     * @param added the directories this policy contributed, in the order they
     *              were inserted; empty means the inherited PATH already had
     *              every directory we know about
     */
    public record Result(String path, List<String> added) {
    }

    /** Static utility — no instances. */
    private ToolPath() {
    }

    /**
     * The policy applied to this JVM's own environment.
     *
     * <p>Recomputed per call rather than cached: it costs a handful of stat
     * calls, and a value frozen at class-load would keep a toolchain installed
     * while the app runs invisible until the next restart — the same class of
     * surprise this card is about.
     *
     * @return the PATH a tool shell gets, and what was added to reach it
     */
    public static Result resolve() {
        return resolve(System.getenv("PATH"),
                Path.of(System.getProperty("user.home", "")), Files::isDirectory);
    }

    /**
     * The policy as a pure function — the seam the tests drive, since a test
     * cannot scrub the JVM's own environment.
     *
     * @param inherited   the PATH as inherited, may be null or blank
     * @param home        the home directory the per-user dirs resolve against
     * @param isDirectory existence check, injected so a test needs no real dirs
     * @return the effective PATH and the directories added to build it
     */
    static Result resolve(String inherited, Path home, Predicate<Path> isDirectory) {
        List<String> inheritedEntries = inherited == null || inherited.isBlank()
                ? List.of()
                : List.of(inherited.split(File.pathSeparator, -1));
        // Membership is by normalized name, so a trailing slash cannot make the
        // policy add a directory that is already searched.
        Set<String> known = new LinkedHashSet<>();
        for (String entry : inheritedEntries) {
            if (!entry.isBlank()) {
                known.add(normalize(entry));
            }
        }

        List<String> candidates = new ArrayList<>(TOOLCHAIN_DIRS);
        // Only against an absolute home. This repo really does start JVMs with
        // an empty -Duser.home (the fresh-user tests), and a relative entry on a
        // PATH resolves against whatever directory a tool happens to run in —
        // an entry that moves under the agent is worse than no entry at all.
        if (home.isAbsolute()) {
            for (String relative : HOME_TOOLCHAIN_DIRS) {
                candidates.add(home.resolve(relative).toString());
            }
        }

        List<String> prepend = missing(candidates, known, isDirectory);
        List<String> append = missing(SYSTEM_FLOOR, known, isDirectory);

        List<String> all = new ArrayList<>(prepend);
        all.addAll(inheritedEntries);
        all.addAll(append);
        List<String> added = new ArrayList<>(prepend);
        added.addAll(append);
        return new Result(String.join(File.pathSeparator, all), List.copyOf(added));
    }

    /**
     * The candidates this host has and this PATH lacks, in the given order.
     * Each accepted directory joins {@code known}, so two candidates naming the
     * same place cannot both be added.
     *
     * @param candidates  absolute directories to consider
     * @param known       normalized names already searched; grows as we accept
     * @param isDirectory existence check
     * @return the directories to insert
     */
    private static List<String> missing(List<String> candidates, Set<String> known,
                                        Predicate<Path> isDirectory) {
        List<String> result = new ArrayList<>();
        for (String candidate : candidates) {
            String name = normalize(candidate);
            if (known.contains(name) || !isDirectory.test(Path.of(name))) {
                continue;
            }
            known.add(name);
            result.add(name);
        }
        return result;
    }

    /**
     * The comparison form of a PATH entry: a trailing separator names the same
     * directory, so {@code /opt/homebrew/bin/} must count as present.
     *
     * @param entry one raw PATH entry
     * @return the entry without trailing slashes
     */
    private static String normalize(String entry) {
        String trimmed = entry;
        while (trimmed.length() > 1 && trimmed.endsWith("/")) {
            trimmed = trimmed.substring(0, trimmed.length() - 1);
        }
        return trimmed;
    }
}
