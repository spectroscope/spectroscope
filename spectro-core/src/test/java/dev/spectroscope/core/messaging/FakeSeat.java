package dev.spectroscope.core.messaging;

import java.util.ArrayList;
import java.util.List;

/** A seat with fixed rows that records what was sent (card 503 tests). */
final class FakeSeat implements MessagingSeat {

    String selfName = "ForgeDemo-a1";
    String selfRef = "a1b2c3";
    boolean child;
    String agentId = "main";
    boolean on = true;
    List<AgentRow> sessions = new ArrayList<>();
    List<AgentRow> runAgents = new ArrayList<>();
    final List<String> sent = new ArrayList<>();
    final List<String> subscribed = new ArrayList<>();
    /** Other children of the caller's session, matched as SubagentManager matches them. */
    final List<String> siblings = new ArrayList<>();
    String failSession;
    String failNotify;
    int ids;

    @Override
    public String selfName() {
        return selfName;
    }

    @Override
    public String selfRef() {
        return selfRef;
    }

    @Override
    public boolean child() {
        return child;
    }

    @Override
    public String agentId() {
        return agentId;
    }

    @Override
    public boolean on() {
        return on;
    }

    @Override
    public List<AgentRow> sessions() {
        return sessions;
    }

    @Override
    public List<AgentRow> runAgents() {
        return runAgents;
    }

    @Override
    public boolean sibling(String name) {
        return siblings.stream().anyMatch(id -> dev.spectroscope.core.peer.PeerNames.same(id, name));
    }

    /** Card 581: children of the caller's session that have ended, by id, with their refusal. */
    final java.util.Map<String, String> endedChildren = new java.util.LinkedHashMap<>();

    @Override
    public String endedChild(String name) {
        return endedChildren.entrySet().stream()
                .filter(entry -> dev.spectroscope.core.peer.PeerNames.same(entry.getKey(), name))
                .map(java.util.Map.Entry::getValue).findFirst().orElse(null);
    }

    @Override
    public Sent sendToSession(AgentRow row, String text, String summary) {
        if (failSession != null) {
            return Sent.failed(failSession);
        }
        sent.add("session:" + row.id() + ":" + summary + ":" + text);
        return Sent.ok("msg-" + (++ids));
    }

    @Override
    public Sent sendInRun(AgentRow row, String text, String summary) {
        sent.add("run:" + row.id() + ":" + summary + ":" + text);
        return Sent.ok("msg-" + (++ids));
    }

    @Override
    public Sent notifyWhenIdle(AgentRow row) {
        if (failNotify != null) {
            return Sent.failed(failNotify);
        }
        subscribed.add(row.id());
        return Sent.ok("sub-" + (++ids));
    }
}
