package dev.spectroscope.core.goal;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;

/**
 * The goal on disk: {@code ~/.spectro/goals/<session-id>.goal.md} (card 267,
 * criterion 1).
 *
 * <p><b>Per session, and stated here rather than left open.</b> Owner call 2
 * asked whether a goal is per session, per run, or a workspace file in the
 * {@code AGENTS.md} shape. Decided while building: <b>per session</b>. A goal is
 * a sentence about what THIS conversation is for; an {@code AGENTS.md}-shaped
 * file in the workspace would silently become the goal of every session anyone
 * ever opens in that directory, including a session opened to do something
 * else. Memory of goals ACROSS sessions is card 185's write half and is
 * deliberately not started here.</p>
 *
 * <p>The layout follows the house's own rule for a new layer: a file of its own
 * beside the session, exactly as {@code .llm.jsonl} sits beside the session
 * JSONL (card 184). Markdown, because criterion 1 says "readable and editable on
 * disk" and the operator is the one who edits it.</p>
 *
 * <p>The format is two headings and the operator's own text under them. It is
 * parsed back leniently — a file a person edited by hand is the normal case, not
 * the exception, so a missing check section is a goal without teeth and never an
 * error.</p>
 */
public final class GoalStore {

    /** The heading the outcome lives under. */
    public static final String OUTCOME_HEADING = "## Outcome";

    /** The heading the check command lives under. */
    public static final String CHECK_HEADING = "## Check";

    /** Static utility — no instances. */
    private GoalStore() {
    }

    /**
     * Where a session's goal file lives.
     *
     * @param sessionId the session file's basename
     * @return the path under {@code ~/.spectro/goals/}
     * @throws IllegalArgumentException when the id is not a plain basename —
     *         the same fence {@code LlmWireRecorder.fileFor} keeps, so a crafted
     *         id cannot write a sidecar into another directory
     */
    public static Path fileFor(String sessionId) {
        if (sessionId == null || !sessionId.matches("[A-Za-z0-9][A-Za-z0-9-]*")) {
            throw new IllegalArgumentException("not a session id: " + sessionId);
        }
        return Path.of(System.getProperty("user.home"), ".spectro", "goals",
                sessionId + ".goal.md");
    }

    /**
     * Writes the goal, creating the directory. A null goal DELETES the file:
     * clearing a goal has to leave nothing behind, or the next reader would
     * re-state a goal the operator withdrew.
     *
     * @param file the goal file
     * @param goal the goal to store, or null to clear
     * @throws IOException when the file cannot be written or removed
     */
    public static void write(Path file, RunGoal goal) throws IOException {
        if (goal == null || !goal.stated()) {
            Files.deleteIfExists(file);
            return;
        }
        Files.createDirectories(file.getParent());
        StringBuilder out = new StringBuilder("# The goal of this session\n\n")
                .append(OUTCOME_HEADING).append("\n\n").append(goal.outcome().strip())
                .append('\n');
        if (goal.hasCheck()) {
            out.append('\n').append(CHECK_HEADING).append("\n\n    ")
                    .append(goal.check().strip()).append('\n');
        }
        Files.writeString(file, out.toString(), StandardCharsets.UTF_8);
    }

    /**
     * Reads the goal back, tolerating a file a person edited.
     *
     * @param file the goal file
     * @return the stored goal, or null when the file is absent, unreadable or
     *         states no outcome
     */
    public static RunGoal read(Path file) {
        String raw;
        try {
            raw = Files.readString(file, StandardCharsets.UTF_8);
        } catch (IOException absent) {
            return null;
        }
        String outcome = section(raw, OUTCOME_HEADING);
        String check = section(raw, CHECK_HEADING);
        if (outcome == null || outcome.isBlank()) {
            return null;
        }
        return new RunGoal(outcome, check == null || check.isBlank() ? null : check);
    }

    /** The text under one heading, up to the next {@code ##} heading or the end.
     *  Lines are de-indented, so the check's four-space code indent comes back
     *  as the command it was.
     *  @param raw     the whole file
     *  @param heading the heading to look under
     *  @return the stripped section body, or null when the heading is absent */
    private static String section(String raw, String heading) {
        int at = raw.indexOf(heading);
        if (at < 0) {
            return null;
        }
        int from = at + heading.length();
        int to = raw.indexOf("\n## ", from);
        String body = to < 0 ? raw.substring(from) : raw.substring(from, to);
        StringBuilder out = new StringBuilder();
        for (String line : body.split("\n", -1)) {
            out.append(line.strip()).append('\n');
        }
        return out.toString().strip();
    }
}
