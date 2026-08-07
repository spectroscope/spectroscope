package dev.spectroscope.server.transcripts;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;

/**
 * The three folders that belong to one recorded session, and where they are.
 *
 * <p>A transcript is not the only thing a session leaves on disk. Beside it sit
 * the agent transcripts and the workflow journals its own runs wrote, and off in
 * the temp tree sits the scratchpad those runs used for working files. All three
 * are ordinary directories, and all three are invisible from the app: the store
 * lives under a dot-folder Finder hides, and the scratchpad lives under a path
 * nobody would guess.</p>
 *
 * <p><b>Derived, never accepted.</b> Every path here is computed from a
 * transcript the caller already proved it may read — the same
 * {@code insideStore} resolution the read endpoints make. Nothing a caller sends
 * is ever opened, which is the whole reason this class exists rather than an
 * "open this path" endpoint: the one thing that must not be possible is turning
 * a local HTTP surface into a way to run {@code open} on an arbitrary file.</p>
 *
 * <p>Pure and I/O-light: it resolves and stats, and it never opens anything.
 * {@link FolderOpener} does that, once, in one place.</p>
 */
final class SessionFolders {

    /** Which folder a caller means. Wire vocabulary, lowercase. */
    enum Kind {
        /** The project directory the transcript sits in. */
        TRANSCRIPT,
        /** {@code <session>/subagents/workflows} — one directory per workflow run. */
        WORKFLOWS,
        /** The temp scratchpad the session's runs wrote working files into. */
        SCRATCHPAD
    }

    /** Where the harness puts its per-session scratchpads. See {@link #scratchpad}. */
    private static final String TEMP_ROOT = "/tmp";

    private SessionFolders() {}

    /**
     * The session id a transcript file names, which is its own filename.
     *
     * @param transcript the resolved transcript
     * @return the id, or null when the name is not a {@code .jsonl}
     */
    static String sessionIdOf(Path transcript) {
        String name = transcript.getFileName().toString();
        return name.endsWith(".jsonl") ? name.substring(0, name.length() - ".jsonl".length()) : null;
    }

    /**
     * Where a session's folder is, whether or not it exists.
     *
     * @param transcript the resolved transcript inside the store
     * @param kind which folder
     * @return the path, or null when this transcript cannot have one
     */
    static Path locate(Path transcript, Kind kind) {
        Path project = transcript.getParent();
        if (project == null) {
            return null;
        }
        String session = sessionIdOf(transcript);
        return switch (kind) {
            case TRANSCRIPT -> project;
            case WORKFLOWS -> session == null
                    ? null
                    : project.resolve(session).resolve("subagents").resolve("workflows");
            case SCRATCHPAD -> session == null ? null : scratchpad(project, session);
        };
    }

    /**
     * The scratchpad for one session, by the layout the harness writes:
     * {@code <tmp>/claude-<uid>/<project>/<session>/scratchpad}.
     *
     * <p><b>{@code /tmp}, not {@code java.io.tmpdir}.</b> On macOS that property
     * is a per-process folder under {@code /var/folders}, and the scratchpad is
     * not there — measured on this machine, the harness writes
     * {@code /tmp/claude-501/...} while the property reads
     * {@code /var/folders/.../T/}. The literal is the layout, and a wrong
     * literal is caught by {@link #isThere}: the button simply does not appear.</p>
     *
     * <p>The uid is read off the user's own home directory rather than guessed
     * or shelled out for. On a filesystem that cannot answer — or on Windows —
     * there is no scratchpad to point at and this says so by returning null,
     * which reads downstream as "the folder is not there", the same answer a
     * session that never made one gets.</p>
     *
     * @param project the project directory inside the store
     * @param session the session id
     * @return the scratchpad path, or null when the layout cannot be resolved
     */
    private static Path scratchpad(Path project, String session) {
        Object uid;
        try {
            uid = Files.getAttribute(Path.of(System.getProperty("user.home")), "unix:uid");
        } catch (IOException | RuntimeException notPosix) {
            return null;
        }
        return Path.of(TEMP_ROOT)
                .resolve("claude-" + uid)
                .resolve(project.getFileName().toString())
                .resolve(session)
                .resolve("scratchpad");
    }

    /**
     * Whether a located folder is really a directory on disk right now.
     *
     * <p>Asked at every request rather than cached: a scratchpad appears when a
     * run makes one and a temp sweep takes it away again, and a button offering
     * a folder that is not there is the kind of small lie this product does not
     * tell.</p>
     *
     * @param folder the located path, possibly null
     * @return true when it exists and is a directory
     */
    static boolean isThere(Path folder) {
        return folder != null && Files.isDirectory(folder);
    }
}
