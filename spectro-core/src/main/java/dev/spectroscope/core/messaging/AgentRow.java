package dev.spectroscope.core.messaging;

import dev.spectroscope.core.peer.LiveRecord;
import dev.spectroscope.core.peer.PeerNames;

/**
 * One agent {@code list_agents} prints and {@code send_message} can address
 * (card 503): a peer session on this machine, or an agent of the caller's own
 * run (its parent or a child). A child never gets a row for another child:
 * hub and spoke (owner, 2026-10-12).
 *
 * @param kind       which of the three this row is
 * @param name       the name the row leads with, which is the address
 * @param ref        the short ref printed after the name
 * @param id         the session id of a session, the agent id of an agent of the run
 * @param face       the face that hosts a session ({@code server}, {@code repl}, ...); the role of an agent
 * @param status     {@code busy}, {@code idle} or {@code waiting} for a session; {@code working} or
 *                   {@code waiting} for an agent of the run
 * @param folder     the session's folder, or null
 * @param statusLine what the harness knows the agent is doing, without a model call, or null
 * @param startedAt  when the session became live, epoch millis; 0 when unknown
 * @param accepting  false when the session takes no messages
 * @param address    the reply address of the session's process ({@code uds:<socket>}), or null
 * @param record     the registry record of a session's process, or null for an agent of the run
 */
public record AgentRow(Kind kind, String name, String ref, String id, String face, String status,
                       String folder, String statusLine, long startedAt, boolean accepting, String address,
                       LiveRecord record) {

    /** What a row stands for. */
    public enum Kind {
        /** A session of this or another process on this machine. */
        SESSION,
        /** The agent that spawned the caller. */
        PARENT,
        /** A running child of the caller's run. */
        CHILD;

        /** @return true for an agent of the caller's own run */
        public boolean inRun() {
            return this != SESSION;
        }
    }

    /**
     * A row for an agent of the caller's run.
     *
     * @param kind       parent or child
     * @param name       its name, which is its agent id ({@code parent} for the parent)
     * @param agentId    its agent id
     * @param role       its role
     * @param status     {@code working} or {@code waiting}
     * @param statusLine its last status line, or null
     * @return the row
     */
    public static AgentRow inRun(Kind kind, String name, String agentId, String role, String status,
                                 String statusLine) {
        return new AgentRow(kind, name, PeerNames.ref("agent", agentId), agentId, role, status, null,
                statusLine, 0L, true, null, null);
    }
}
