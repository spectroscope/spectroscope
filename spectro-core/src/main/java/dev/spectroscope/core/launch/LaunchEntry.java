package dev.spectroscope.core.launch;

import java.util.List;

/**
 * One configuration out of a {@code .claude/launch.json} — the app under test,
 * named, with whatever it takes to bring it up and the address to look at it on.
 *
 * <p><b>The shape is Claude Code's, not ours</b> (card 202). It was measured
 * rather than remembered: every readable {@code .claude/launch.json} under the
 * operator's home was parsed on 2026-08-13, and the count is in the class
 * documentation of {@link LaunchFile}. What that measurement found is exactly
 * the four keys below plus {@code url}, and the reader must survive keys it has
 * never heard of, because a file Claude Code runs has to load here unedited.
 *
 * @param name              how the agent addresses this configuration
 * @param port              the port the app answers on, or null when the entry
 *                          names only a {@code url}
 * @param runtimeExecutable the program to run, or null for an attach entry
 * @param runtimeArgs       its arguments, never null — empty when the entry has none
 * @param url               the address to open instead of {@code http://localhost:<port>/},
 *                          or null
 * @param unknownKeys       every key in the entry this reader does not use, kept
 *                          so {@code launch_list} can say what it ignored rather
 *                          than pretending the file was simpler than it is
 */
public record LaunchEntry(String name, Integer port, String runtimeExecutable,
                          List<String> runtimeArgs, String url, List<String> unknownKeys) {

    /** Defensive copies, so a caller cannot mutate an entry after it was read. */
    public LaunchEntry {
        runtimeArgs = runtimeArgs == null ? List.of() : List.copyOf(runtimeArgs);
        unknownKeys = unknownKeys == null ? List.of() : List.copyOf(unknownKeys);
    }

    /**
     * Whether this is an entry spectroscope cannot run.
     *
     * <p>The format allows a {@code url} with no command at all, and such an
     * entry means "the server is already up, look at it" — card 202 criterion 2.
     * Nothing is spawned for it. No file on this machine carried the shape when
     * the corpus was measured (0 of 58 entries), which is why the fixture beside
     * the compatibility test exists: the shape is part of the format whether or
     * not anybody here has written one yet.
     *
     * @return true when the entry names no program to run
     */
    public boolean attaches() {
        return runtimeExecutable == null || runtimeExecutable.isBlank();
    }

    /**
     * The address the browser is pointed at for this entry.
     *
     * <p>The {@code url} wins when the entry names one; otherwise the port
     * becomes a loopback address. Loopback is the whole point of this card and
     * also the one thing the net fence refuses by default — see
     * {@link LaunchTools} for what a reader is told when the two meet.
     *
     * @return the address, or null when the entry carries neither a url nor a port
     */
    public String address() {
        if (url != null && !url.isBlank()) {
            return url.strip();
        }
        if (port != null && port > 0) {
            return "http://localhost:" + port + "/";
        }
        return null;
    }

    /**
     * The command line, for a sentence that has to say what was run.
     *
     * <p>An argument carrying whitespace or a shell metacharacter is quoted, so
     * the reader can tell one argument from two. Plain space-joining printed
     * {@code /bin/sh -c python3 -m http.server 51824 & sleep 2}, which reads as
     * eight arguments where there are two and is not copy-pasteable — a review
     * caught it in a live drive on 2026-08-13. Nothing here is ever executed:
     * the process is built from the argument LIST, so this quoting is for the
     * human and the model, never for a shell.
     *
     * @return the executable and its arguments, each quoted where it needs to be,
     *         or "" for an attach entry
     */
    public String commandLine() {
        if (attaches()) {
            return "";
        }
        StringBuilder line = new StringBuilder(quoted(runtimeExecutable));
        for (String argument : runtimeArgs) {
            line.append(' ').append(quoted(argument));
        }
        return line.toString();
    }

    /** One argument as a reader can tell it apart from its neighbours. */
    private static String quoted(String argument) {
        if (argument == null || argument.isEmpty()) {
            return "''";
        }
        if (argument.chars().noneMatch(LaunchEntry::needsQuoting)) {
            return argument;
        }
        return "'" + argument.replace("'", "'\\''") + "'";
    }

    /** Whether one character makes an argument ambiguous inside a sentence. */
    private static boolean needsQuoting(int character) {
        return Character.isWhitespace(character)
                || "'\"\\$`&;|<>()*?[]{}#!~".indexOf(character) >= 0;
    }
}
