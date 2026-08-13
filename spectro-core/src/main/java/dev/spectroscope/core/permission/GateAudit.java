package dev.spectroscope.core.permission;

import com.fasterxml.jackson.annotation.JsonInclude;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import dev.spectroscope.core.events.RunEvent.PermissionRequest;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardOpenOption;

/**
 * One line per gate decision: {@code ~/.spectro/gate-audit/&lt;session-id&gt;.gate.jsonl}.
 *
 * <p><b>Why a sidecar.</b> The RunEvent wire is byte-frozen. {@code
 * permission_decision} carries a callId, a boolean and a timestamp, and it keeps
 * carrying exactly that; adding a tier to it would change an existing event.
 * So this follows the pattern card 184 established for the llm-wire: a file
 * beside the session, additive, ignorable by anything that does not know it.
 *
 * <p><b>What it records.</b> Which tool, the tier it resolved to, which section
 * of the map decided that, the map's version, whether the call was allowed, who
 * decided, and — when the allowlist decided — the raw entry that approved it.
 * That last field is what makes an entry nobody remembers writing findable: the
 * exact-name hole card 199 leaves open is answered with visibility, and this is
 * the surface that visibility is on.
 *
 * <p><b>What it never records.</b> The call's input. A {@code run_command}
 * argument or a {@code web_fetch} URL routinely carries a credential, and an
 * audit file that quietly accumulates them would be a worse leak than the thing
 * it audits.
 *
 * <p>An audit is a record, not a gate: every write failure is swallowed. A
 * machine with a full disk must still be able to approve and refuse.
 */
public final class GateAudit implements AutoCloseable {

    /** NON_NULL keeps absent fields — an entry on a refusal — off the file. */
    private static final ObjectMapper JSON = new ObjectMapper()
            .setSerializationInclusion(JsonInclude.Include.NON_NULL);

    private final Path file;
    private final Object lock = new Object();

    /**
     * @param file the sidecar to append to; created with its parent on the first line
     */
    public GateAudit(Path file) {
        this.file = file;
    }

    /**
     * The production wiring: the sidecar of one session, next to (not inside)
     * the session's own JSONL, exactly like the llm-wire record.
     *
     * @param sessionId the session the decisions belong to
     * @return a recorder appending to {@code ~/.spectro/gate-audit/&lt;id&gt;.gate.jsonl}
     */
    public static GateAudit forSession(String sessionId) {
        return new GateAudit(fileFor(sessionId));
    }

    /**
     * Where a session's gate audit lives.
     *
     * @param sessionId the session id
     * @return the sidecar path under {@code ~/.spectro/gate-audit/}
     */
    public static Path fileFor(String sessionId) {
        return Path.of(System.getProperty("user.home"), ".spectro", "gate-audit",
                sessionId + ".gate.jsonl");
    }

    /** @return the file this recorder appends to */
    public Path file() {
        return file;
    }

    /**
     * Records one decision.
     *
     * @param request   the call that was decided — name and ids only; the input is not read
     * @param decidedBy who decided: "allowlist", "user", "mode:auto", "mode:readonly",
     *                  "policy:auto", "policy:deny", "hook" …
     * @param allowed   the verdict that was acted on
     * @param verdict   the allowlist's own reading — tier, source, map version, entry
     */
    public void record(PermissionRequest request, String decidedBy, boolean allowed,
                       Allowlist.Verdict verdict) {
        ObjectNode line = JSON.createObjectNode();
        line.put("type", "gate_decision");
        line.put("ts", System.currentTimeMillis());
        line.put("callId", request.callId());
        line.put("agentId", request.agentId());
        line.put("tool", request.name());
        if (verdict != null) {
            line.put("tier", verdict.toolTier() == null ? null : verdict.toolTier().wireName());
            line.put("tierSource", verdict.source());
            line.put("mapVersion", verdict.mapVersion());
            if (allowed && verdict.entry() != null) {
                line.put("entry", verdict.entry());
                line.put("entryCeiling",
                        verdict.ceiling() == null ? null : verdict.ceiling().wireName());
            }
        }
        line.put("decision", allowed ? "allow" : "deny");
        line.put("decidedBy", decidedBy);
        append(line);
    }

    /** One serialized line, appended under O_APPEND — no handle is held between
     *  writes, the pattern {@code SessionStore.append} already trusts. */
    private void append(ObjectNode line) {
        synchronized (lock) {
            try {
                Path parent = file.toAbsolutePath().getParent();
                if (parent != null) {
                    Files.createDirectories(parent);
                }
                Files.writeString(file, JSON.writeValueAsString(line) + "\n",
                        StandardCharsets.UTF_8, StandardOpenOption.CREATE, StandardOpenOption.APPEND);
            } catch (IOException | RuntimeException recordOnly) {
                // An audit is a record, not a gate. A disk that cannot take the
                // line must not turn into a call that cannot be decided.
            }
        }
    }

    @Override
    public void close() {
        // Per-line appends hold no handle; there is nothing to release.
    }
}
