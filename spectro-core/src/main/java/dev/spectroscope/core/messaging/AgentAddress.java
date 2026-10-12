package dev.spectroscope.core.messaging;

import dev.spectroscope.core.peer.PeerClient;
import dev.spectroscope.core.peer.PeerNames;

import java.util.ArrayList;
import java.util.List;
import java.util.Locale;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * How {@code send_message} reads its {@code to} (card 503 criterion 1,
 * reader 01 section Addressing).
 *
 * <p>The name a listing prints is the address. A match is exact after NFKC,
 * trimming and lower case; a prefix is no match. An agent of the caller's own
 * run wins over a session of the same name. Two sessions of one name need the
 * ref the listing prints after the name, written as {@code name [ref]}. The
 * reply address in a message's {@code from} attribute,
 * {@code uds:<socket>/<session id>}, reaches that session, and the bare
 * {@code uds:<socket>} of a process reaches its only session. A name that
 * reached one agent earlier in the run and names another one now is refused,
 * so a restarted session is never written to under an old pin by accident.</p>
 */
public final class AgentAddress {

    /** {@code name [ref]}, the ref six to twelve lower case hex characters. */
    private static final Pattern WITH_REF = Pattern.compile("^(.*\\S)\\s*\\[([0-9a-f]{6,12})\\]$");
    private static final String UDS = "uds:";

    private AgentAddress() {
    }

    /**
     * What {@code to} reached.
     *
     * @param row     the agent, or null when nothing was reached
     * @param refusal the text for the model when nothing was reached, else null
     */
    public record Result(AgentRow row, String refusal) {

        static Result found(AgentRow row) {
            return new Result(row, null);
        }

        static Result refused(String text) {
            return new Result(null, text);
        }
    }

    /**
     * Resolves one address against the rows of this moment.
     *
     * @param to   the address the model wrote
     * @param rows every reachable agent: the run's own and the sessions
     * @param pins the names this run already sent to
     * @return the row, or the refusal
     */
    public static Result resolve(String to, List<AgentRow> rows, AddressPins pins) {
        if (to == null || to.isBlank()) {
            return Result.refused("Not sent: to must name an agent from list_agents.");
        }
        if (to.indexOf('\n') >= 0 || to.indexOf('\r') >= 0) {
            return Result.refused("Not sent: to must be one line, a name from list_agents.");
        }
        String trimmed = to.strip();
        if (trimmed.startsWith(UDS)) {
            return byAddress(trimmed, rows);
        }
        String name = trimmed;
        String ref = null;
        Matcher withRef = WITH_REF.matcher(trimmed);
        if (withRef.matches()) {
            name = withRef.group(1).strip();
            ref = withRef.group(2);
        }
        List<AgentRow> named = new ArrayList<>();
        for (AgentRow row : rows) {
            if (PeerNames.same(row.name(), name)) {
                named.add(row);
            }
        }
        if (named.isEmpty()) {
            return Result.refused(PeerClient.unknownName(trimmed));
        }
        if (ref != null) {
            for (AgentRow row : named) {
                if (row.ref() != null && row.ref().startsWith(ref.toLowerCase(Locale.ROOT))) {
                    return Result.found(row);
                }
            }
            return Result.refused("Not sent: no agent named '" + name + "' has the ref [" + ref + "]; call"
                    + " list_agents and copy the ref it prints.");
        }
        List<AgentRow> inRun = named.stream().filter(row -> row.kind().inRun()).toList();
        List<AgentRow> chosen = inRun.isEmpty() ? named : inRun;
        if (chosen.size() > 1) {
            return ambiguous(name, chosen);
        }
        AgentRow row = chosen.getFirst();
        String rebound = pins.rebound(name, row);
        if (rebound != null) {
            return Result.refused("Not sent: '" + name + "' now names a different agent than the one this run"
                    + " messaged before (was it restarted?). If you mean the new one, send to '" + name + " ["
                    + row.ref() + "]'.");
        }
        return Result.found(row);
    }

    /**
     * The bare name in an address, for the words of a refusal (hub and spoke
     * review, round 2). Every invisible format character (Unicode category Cf,
     * such as a zero width space) goes, and so does a trailing ref as
     * list_agents prints one ({@code name [a1b2c3]}).
     *
     * @param to the address the model wrote, or null
     * @return the name without ref and format characters, or null for null
     */
    public static String bare(String to) {
        if (to == null) {
            return null;
        }
        StringBuilder out = new StringBuilder(to.length());
        to.codePoints().filter(c -> Character.getType(c) != Character.FORMAT).forEach(out::appendCodePoint);
        String name = out.toString().strip();
        Matcher withRef = WITH_REF.matcher(name);
        return withRef.matches() ? withRef.group(1).strip() : name;
    }

    private static Result byAddress(String to, List<AgentRow> rows) {
        List<AgentRow> process = new ArrayList<>();
        for (AgentRow row : rows) {
            if (row.address() == null) {
                continue;
            }
            if (to.equals(row.address() + "/" + row.id())) {
                return Result.found(row);
            }
            if (to.equals(row.address())) {
                process.add(row);
            }
        }
        if (process.size() == 1) {
            return Result.found(process.getFirst());
        }
        if (process.size() > 1) {
            return ambiguous(to, process);
        }
        return Result.refused(PeerClient.unknownName(to));
    }

    private static Result ambiguous(String name, List<AgentRow> rows) {
        StringBuilder out = new StringBuilder("Not sent: ")
                .append(rows.size() == 2 ? "two agents" : rows.size() + " agents")
                .append(" answer to '").append(name).append("'. Send to one of");
        for (int i = 0; i < rows.size(); i++) {
            AgentRow row = rows.get(i);
            out.append(i == 0 ? " " : ", ").append('\'').append(row.name()).append(" [").append(row.ref())
                    .append("]'");
        }
        return Result.refused(out.append(", as list_agents prints them.").toString());
    }
}
