package dev.spectroscope.core.provider;

import dev.spectroscope.core.subagents.RoleCatalog;

import static org.junit.jupiter.api.Assertions.assertEquals;

/**
 * The one change card 601 made to a v0.14.4 request body: the two spawn
 * descriptions name the explore belt from its set, {@code code_graph}
 * included. A byte comparison against a v0.14.4 capture applies exactly this
 * change to the capture and nothing else, so every other byte stays pinned.
 */
final class Card601SpawnTexts {

    /** The {@code spawn_agent} description v0.14.4 sent. */
    static final String SPAWN_AGENT_V0144 = "Starts a subagent with a fresh context and waits for its result. "
            + "type=explore: read-only (list_dir, read_file, glob, grep), for research. type=worker: all tools, "
            + "for real subtasks. The subagent sees ONLY the task text, so phrase it as a self-contained "
            + "assignment and ask the child for a short digest with path and line, not for file contents.";

    /** The {@code spawn_agents} description v0.14.4 sent, with no session count. */
    static final String SPAWN_AGENTS_V0144 = "Starts up to 4 subagents IN PARALLEL and waits until all of "
            + "them are finished. For independent subtasks (e.g. investigating several directories at the "
            + "same time). Write each task as a self-contained assignment and ask each child for a short "
            + "digest with path and line, not for file contents.";

    private Card601SpawnTexts() {
    }

    /**
     * A v0.14.4 capture with card 601's change applied: each old description
     * is found exactly once and replaced by today's.
     *
     * @param capture the captured bytes
     * @return the bytes a body sends since card 601
     */
    static String applied(String capture) {
        String spawnAgent = RoleCatalog.parentTools().get(0).description();
        String spawnAgents = RoleCatalog.parentTools().get(1).description();
        assertEquals(1, occurrences(capture, SPAWN_AGENT_V0144), "premise: the capture carries spawn_agent once");
        assertEquals(1, occurrences(capture, SPAWN_AGENTS_V0144), "premise: the capture carries spawn_agents once");
        return capture.replace(SPAWN_AGENT_V0144, spawnAgent).replace(SPAWN_AGENTS_V0144, spawnAgents);
    }

    private static int occurrences(String text, String part) {
        int count = 0;
        for (int at = text.indexOf(part); at >= 0; at = text.indexOf(part, at + part.length())) {
            count++;
        }
        return count;
    }
}
