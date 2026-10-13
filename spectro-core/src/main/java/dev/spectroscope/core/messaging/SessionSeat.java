package dev.spectroscope.core.messaging;

import dev.spectroscope.core.peer.LiveRecord;
import dev.spectroscope.core.peer.PeerNames;
import dev.spectroscope.core.peer.PeerNode;
import dev.spectroscope.core.subagents.SubagentManager;

import java.util.ArrayList;
import java.util.List;
import java.util.function.BooleanSupplier;
import java.util.function.Supplier;

/**
 * The seat of a session's main agent (card 503): its name in the registry of
 * card 502, the sessions on this machine as the registry lists them, and the
 * children of its run. A browser session and the REPL build one; the three
 * suppliers are read on every call, because the node, the session and the
 * subagent manager of a face appear after the tools are registered.
 */
public final class SessionSeat implements MessagingSeat {

    private final Supplier<PeerNode> node;
    private final Supplier<String> sessionId;
    private final Supplier<SubagentManager> subagents;
    private final BooleanSupplier on;
    private final String agentId;

    /**
     * @param node      the process's peer node, or a supplier of null when this process has none
     * @param sessionId the session the agent runs in
     * @param subagents the session's subagent manager, or a supplier of null
     * @param on        whether agent messaging is on for the agent right now
     * @param agentId   the main agent's id
     */
    public SessionSeat(Supplier<PeerNode> node, Supplier<String> sessionId, Supplier<SubagentManager> subagents,
                       BooleanSupplier on, String agentId) {
        this.node = node;
        this.sessionId = sessionId;
        this.subagents = subagents;
        this.on = on;
        this.agentId = agentId;
    }

    @Override
    public String selfName() {
        PeerNode peers = node.get();
        String id = sessionId.get();
        return peers == null || id == null ? agentId : peers.nameOf(id);
    }

    @Override
    public String selfRef() {
        String id = sessionId.get();
        return PeerNames.ref("session", id == null ? agentId : id);
    }

    @Override
    public boolean child() {
        return false;
    }

    @Override
    public String agentId() {
        return agentId;
    }

    @Override
    public boolean on() {
        return on.getAsBoolean();
    }

    @Override
    public List<AgentRow> sessions() {
        PeerNode peers = node.get();
        if (peers == null) {
            return List.of();
        }
        String own = sessionId.get();
        List<AgentRow> rows = new ArrayList<>();
        for (LiveRecord record : peers.roster()) {
            boolean accepting = !Boolean.FALSE.equals(record.accepting());
            String address = record.socket() == null ? null : "uds:" + record.socket();
            for (LiveRecord.Session session : record.sessions()) {
                if (record.pid() == peers.pid() && session.id().equals(own)) {
                    continue;
                }
                long started = session.since() != null && session.since() > 0 ? session.since() : record.startedAt();
                rows.add(new AgentRow(AgentRow.Kind.SESSION, PeerNames.shown(session.name()),
                        PeerNames.ref("session", session.id()), session.id(), record.face(), session.status(),
                        session.cwd(), session.statusLine(), started, accepting, address, record));
            }
        }
        return rows;
    }

    @Override
    public List<AgentRow> runAgents() {
        SubagentManager manager = subagents.get();
        return manager == null ? List.of() : manager.childRows();
    }

    @Override
    public Sent sendToSession(AgentRow row, String text, String summary) {
        PeerNode peers = node.get();
        String own = sessionId.get();
        if (peers == null || own == null) {
            return Sent.failed("Not sent: this process takes no part in agent messaging.");
        }
        PeerNode.SendResult result = peers.sendTo(own, row.record(), row.id(), row.name(), text, summary);
        return result.sent() ? Sent.ok(result.msgId()) : Sent.failed(result.text());
    }

    @Override
    public Sent sendInRun(AgentRow row, String text, String summary) {
        return sendInRun(row, text, summary, false);
    }

    @Override
    public Sent sendInRun(AgentRow row, String text, String summary, boolean recorded) {
        SubagentManager manager = subagents.get();
        if (manager == null) {
            return Sent.failed(dev.spectroscope.core.peer.PeerClient.unknownName(row.name()));
        }
        return manager.sendFromParent(row, text, summary, recorded);
    }

    @Override
    public Sent notifyWhenIdle(AgentRow row) {
        PeerNode peers = node.get();
        String own = sessionId.get();
        if (peers == null || own == null) {
            return Sent.failed("Not subscribed: this process takes no part in agent messaging.");
        }
        PeerNode.SendResult result = peers.notifyWhenIdle(own, row.record(), row.id(), row.name());
        return result.sent() ? Sent.ok(result.msgId()) : Sent.failed(result.text());
    }
}
