package dev.spectroscope.server.transcripts;

import com.fasterxml.jackson.core.JsonEncoding;
import com.fasterxml.jackson.core.JsonFactory;
import com.fasterxml.jackson.core.JsonGenerator;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.List;
import java.util.stream.Stream;

/**
 * One recorded run as TEXTS — the session transcript, every agent transcript
 * beside it, and every workflow run state — in one answer.
 *
 * <p><b>Why the server does this at all.</b> The browser already owns the merge:
 * {@code importClaudeCodeRun} takes three sets of texts and hands back one
 * stream, and it is the path the folder picker has used since card 291. What the
 * store list could not do was READ those texts — {@code ~/.claude} is invisible
 * to a file chooser, so the dialog fetched the session file alone and a session
 * with hundreds of agents beside it opened with none of them (card 318). This
 * class is the missing read and nothing else: no parsing, no merging, no
 * opinion about what a transcript means. The field names it writes ARE the
 * importer's input shape, so the answer goes straight into the merge that is
 * already tested.</p>
 *
 * <p><b>Derived, never accepted.</b> Every path here is computed from a
 * transcript the caller already proved it may read, the way {@link
 * SessionFolders} computes the folder buttons' targets. The agent set comes from
 * {@link TranscriptFacts#sidecarAgentsBeside} — the SAME walk the
 * {@code /sidecars} listing answers with, deliberately, because those two now
 * describe the same agents on the same screen and a second rule for "what is an
 * agent beside this session" is a second rule that can drift.</p>
 *
 * <p><b>Sized before it is read.</b> {@link #totalBytes()} is a sum of
 * {@code stat} calls, so the ceiling can refuse a run without materialising a
 * byte of it. That ordering is the whole protection: the alternative reads 104
 * MiB into heap and only then decides it was too much.</p>
 */
final class RunBundle {

    /** Streaming writer: one file is in memory at a time, never all of them. */
    private static final JsonFactory FACTORY = new JsonFactory();

    /** A workflow run's id, and so its state file's name, starts with this. */
    private static final String RUN_PREFIX = "wf_";

    /** {@code <session>/workflows/<runId>.json}. */
    private static final String STATE_SUFFIX = ".json";

    /**
     * How much of the answer to allocate up front. The generator grows past it
     * when it must; the cap only keeps a big bundle from asking for its whole
     * size in one block before anything has been read.
     */
    private static final int MAX_PREALLOCATED = 64 * 1024 * 1024;

    /** One child: its transcript, and the meta beside it (null when absent). */
    private record Agent(String agentId, String runId, Path jsonl, Path meta) {}

    /** One workflow run's own recorded state. */
    private record State(String runId, Path file) {}

    private final Path session;
    private final List<Agent> agents;
    private final List<State> states;
    private final long totalBytes;

    private RunBundle(Path session, List<Agent> agents, List<State> states, long totalBytes) {
        this.session = session;
        this.agents = agents;
        this.states = states;
        this.totalBytes = totalBytes;
    }

    /**
     * What sits beside one session, weighed and not yet read.
     *
     * @param session the resolved transcript inside the store
     * @param root the store root as a REAL path — the same resolution the
     *             transcript itself went through, so the relative paths the
     *             agent walk hands back resolve to the files it found. A base
     *             reached through a symlink (macOS puts every temp dir behind
     *             one) would otherwise round-trip through {@code ..} segments
     *             the kernel resolves after the link, and land somewhere else
     * @return the bundle's file set and what it weighs
     */
    static RunBundle beside(Path session, Path root) {
        List<Agent> agents = new ArrayList<>();
        for (TranscriptFacts.SidecarAgent a : TranscriptFacts.sidecarAgentsBeside(session, root)) {
            Path jsonl = root.resolve(a.path());
            Path meta = jsonl.resolveSibling("agent-" + a.agentId() + ".meta.json");
            agents.add(new Agent(a.agentId(), a.runId(), jsonl, Files.isRegularFile(meta) ? meta : null));
        }
        List<State> states = statesIn(SessionFolders.runStates(session));
        long total = sizeOf(session);
        for (Agent a : agents) {
            total += sizeOf(a.jsonl()) + sizeOf(a.meta());
        }
        for (State s : states) {
            total += sizeOf(s.file());
        }
        return new RunBundle(session, List.copyOf(agents), states, total);
    }

    /**
     * The run states a session recorded, read from their own folder.
     *
     * <p>Listed, never derived from the agent directories. Measured on the
     * owner's session: 47 run directories and 46 state files, because one run
     * has agents and never wrote a state. Deriving either side from the other
     * would invent a file or drop that run's agents with it. A state file
     * without agents is kept for the same reason in reverse — that is exactly
     * what {@code childrenUnrecorded} is counted from (card 297).</p>
     *
     * @param folder {@code <session>/workflows}, or null
     * @return one entry per {@code wf_*.json}, by run id
     */
    private static List<State> statesIn(Path folder) {
        if (folder == null || !Files.isDirectory(folder)) {
            return List.of();
        }
        List<State> found = new ArrayList<>();
        try (Stream<Path> list = Files.list(folder)) {
            for (Path entry : (Iterable<Path>) list::iterator) {
                String name = entry.getFileName().toString();
                if (!name.startsWith(RUN_PREFIX) || !name.endsWith(STATE_SUFFIX)
                        || !Files.isRegularFile(entry)) {
                    continue;
                }
                found.add(new State(name.substring(0, name.length() - STATE_SUFFIX.length()), entry));
            }
        } catch (IOException unreadable) {
            return List.of();
        }
        found.sort(Comparator.comparing(State::runId));
        return List.copyOf(found);
    }

    /** @return what this bundle weighs on disk, summed from stats alone */
    long totalBytes() {
        return totalBytes;
    }

    /**
     * The bundle as JSON, one file at a time.
     *
     * <p>The field names are the contract: {@code sessionText},
     * {@code sidecars[].jsonlText}, {@code sidecars[].metaJson},
     * {@code sidecars[].runId}, {@code runStates[].runId} and
     * {@code runStates[].json} are exactly what {@code SidecarText} and
     * {@code RunStateText} take in the browser, so the answer reaches the merge
     * with nothing in between to get it wrong.</p>
     *
     * <p>{@code runId} is OMITTED for a direct spawn rather than written null:
     * the browser's field is optional and a null there is not the same value.
     * A workflow child's whole meta is
     * {@code {"agentType":"workflow-subagent","spawnDepth":1}} — there is no
     * join key in it at all — so the run directory is the only attribution
     * there is, and it is read from the path rather than invented.</p>
     *
     * @param rel the session's store-relative path, echoed back so the client
     *            can tell which row an answer belongs to
     * @param limitBytes the server's ceiling, published so the dialog can say
     *                   what a refusal will mean before it meets one
     * @return the UTF-8 body
     * @throws IOException when the SESSION itself cannot be read — a child that
     *                     cannot be read is a child, and degrades to an empty
     *                     text the coordinator skips and counts, exactly as an
     *                     unreadable pick does in the dialog
     */
    byte[] json(String rel, long limitBytes) throws IOException {
        byte[] sessionBytes = Files.readAllBytes(session);
        ByteArrayOutputStream out = new ByteArrayOutputStream(preallocate());
        try (JsonGenerator g = FACTORY.createGenerator(out, JsonEncoding.UTF8)) {
            g.writeStartObject();
            g.writeStringField("path", rel);
            g.writeStringField("sessionText", new String(sessionBytes, StandardCharsets.UTF_8));
            g.writeNumberField("limitBytes", limitBytes);
            g.writeNumberField("totalBytes", totalBytes);
            g.writeArrayFieldStart("sidecars");
            for (Agent a : agents) {
                g.writeStartObject();
                g.writeStringField("agentId", a.agentId());
                if (a.runId() != null) {
                    g.writeStringField("runId", a.runId());
                }
                g.writeStringField("jsonlText", text(a.jsonl()));
                g.writeStringField("metaJson", text(a.meta()));
                g.writeEndObject();
            }
            g.writeEndArray();
            g.writeArrayFieldStart("runStates");
            for (State s : states) {
                g.writeStartObject();
                g.writeStringField("runId", s.runId());
                g.writeStringField("json", text(s.file()));
                g.writeEndObject();
            }
            g.writeEndArray();
            g.writeEndObject();
        }
        return out.toByteArray();
    }

    /**
     * The refusal, with BOTH numbers in it.
     *
     * <p>JSON rather than the prose {@code /content} answers with, because this
     * one is read by the client and printed as a sentence of its own: the row
     * degrades to the session file and says, in the reader's language, how big
     * the run was and how much this server will carry. A prose body would make
     * that sentence a parse of English.</p>
     *
     * @param totalBytes what the bundle weighs
     * @param limitBytes what this server allows
     * @return the UTF-8 body
     */
    static byte[] refusal(long totalBytes, long limitBytes) {
        return ("{\"totalBytes\":" + totalBytes + ",\"limitBytes\":" + limitBytes + "}")
                .getBytes(StandardCharsets.UTF_8);
    }

    /** @return the initial buffer, generous but never the whole ceiling */
    private int preallocate() {
        return (int) Math.min(totalBytes + (totalBytes / 8) + 1024, MAX_PREALLOCATED);
    }

    /**
     * One child file as text, or "" when it is not there or will not read.
     *
     * <p>Decoded rather than {@code readString}: a transcript with one malformed
     * byte would throw there, and losing a whole run over a bad byte in one
     * child is not a trade this endpoint gets to make. The replacement
     * character is what the browser would show anyway.</p>
     *
     * @param file the file, possibly null
     * @return its text
     */
    private static String text(Path file) {
        if (file == null) {
            return "";
        }
        try {
            return new String(Files.readAllBytes(file), StandardCharsets.UTF_8);
        } catch (IOException unreadable) {
            return "";
        }
    }

    /**
     * A file's size, or 0 when it cannot be stated.
     *
     * @param file the file, possibly null
     * @return the size in bytes
     */
    private static long sizeOf(Path file) {
        if (file == null) {
            return 0L;
        }
        try {
            return Files.size(file);
        } catch (IOException gone) {
            return 0L;
        }
    }
}
