package dev.spectroscope.server;

import com.fasterxml.jackson.annotation.JsonInclude;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;

import java.io.BufferedReader;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Locale;
import java.util.Set;
import java.util.stream.Stream;

/**
 * Reads one Claude Code transcript into the few facts the import dialog puts on
 * a row: which models ran, how many Workflow calls it contains, how many
 * subagents it spawned, what language the operator typed in, and the opening
 * prompt.
 *
 * <p>Three things about that format were measured before this was written,
 * because the obvious guesses are all wrong on the operator's real store:</p>
 * <ul>
 *   <li><b>Subagents are not in the transcript.</b> {@code isSidechain} is
 *       false on every record of every file sampled, and not one transcript
 *       carries a {@code Task} tool call. Subagents live in sibling files under
 *       {@code <session>/subagents/agent-*.jsonl}, so that count costs a
 *       directory listing and no transcript bytes at all.</li>
 *   <li><b>No prefix answers the model question.</b> Across the 60 largest
 *       transcripts the last previously-unseen model first speaks at a median
 *       27% of the way in, 94% at the ninetieth, and in one file on the final
 *       line. 45% of sampled files ran on more than one model. A fold that
 *       stops early does not save time, it reports a different session.</li>
 *   <li><b>The opening prompt is genuinely cheap.</b> It sits at a median 8.5 KB
 *       in, 11 KB at the ninetieth, 57 KB at the worst — a head prefix would
 *       do. It is folded here anyway because the read that models require has
 *       already passed those bytes, and a second pass over the head would cost
 *       more wall time than it saves.</li>
 * </ul>
 *
 * <p>The fold is total: a broken line is skipped, an unreadable file folds to
 * empty. Browsing somebody else's store must not be able to break the dialog,
 * and a transcript being appended to right now will always have a torn last
 * line.</p>
 */
final class TranscriptFacts {

    private TranscriptFacts() {}

    /** The most prompt characters a row carries. A row shows a prompt, not a transcript. */
    static final int MAX_PROMPT_CHARS = 400;

    /** Fewest words before the language guess is allowed to speak at all. */
    private static final int MIN_WORDS_TO_JUDGE = 4;

    /** Fewest matched markers before one language beats the other. */
    private static final int MIN_MARKERS_TO_JUDGE = 2;

    private static final ObjectMapper MAPPER = new ObjectMapper();

    /**
     * What one transcript row knows about itself.
     *
     * <p>Unknown facts are {@code null} and are omitted from the wire entirely,
     * so the dialog renders a blank rather than inventing a dash. An empty
     * {@code models} list is not an unknown: it says this transcript records no
     * model, which is a true and different thing.</p>
     *
     * @param path the base-relative path, echoed so a batched answer can be matched up
     * @param models every model that spoke, in the order it first spoke
     * @param workflowCalls Workflow tool calls in the transcript body
     * @param subagents agent transcripts directly in the session's sidecar folder
     * @param workflowAgents agent transcripts below that, in the workflow run dirs
     * @param language {@code "de"}, {@code "en"}, or null when the prompts do not say
     * @param firstPrompt the opening user prompt, verbatim and bounded, or null
     */
    @JsonInclude(JsonInclude.Include.NON_NULL)
    record Facts(
            String path,
            List<String> models,
            int workflowCalls,
            int subagents,
            int workflowAgents,
            String language,
            String firstPrompt) {

        /** The empty answer for a file that could not be read. */
        static Facts none(String path) {
            return new Facts(path, List.of(), 0, 0, 0, null, null);
        }

        /** Re-labels a folded answer with the path the caller asked under. */
        Facts at(String path) {
            return new Facts(path, models, workflowCalls, subagents, workflowAgents, language,
                    firstPrompt);
        }

        /**
         * Stamps the ask-time sidecar counts onto a folded answer. The fold is
         * cached under the transcript's file state; the sidecar folder is a
         * different filesystem object that moves while the transcript sits
         * still, so its counts never travel through that cache.
         */
        Facts withSidecars(Sidecars sidecars) {
            return new Facts(path, models, workflowCalls, sidecars.subagents(),
                    sidecars.workflowAgents(), language, firstPrompt);
        }
    }

    /**
     * The two agent populations in one session's sidecar folder. They are
     * different facts and are counted apart: a direct file under
     * {@code subagents/} is an agent this session spawned itself; everything
     * deeper belongs to a workflow run under {@code subagents/workflows/<runId>/}.
     * On the operator's real store the deep population is 85% of all agent
     * transcripts, which is why a counter that saw only the direct files read
     * "no fan-out" on exactly the sessions with the most fan-out.
     *
     * @param subagents {@code agent-*.jsonl} directly under {@code subagents/}
     * @param workflowAgents {@code agent-*.jsonl} anywhere below that
     */
    record Sidecars(int subagents, int workflowAgents) {
        static final Sidecars NONE = new Sidecars(0, 0);
    }

    /**
     * Folds one transcript body. Sidecar counts are deliberately NOT in here:
     * this result is what the cache stores under the transcript's file state,
     * and the sidecar folder moves independently of that state. The caller
     * stamps them on with {@link Facts#withSidecars} at ask time.
     *
     * @param file the absolute transcript path
     * @return the facts; never null, never throwing
     */
    static Facts fold(Path file) {
        Set<String> models = new LinkedHashSet<>();
        // By tool_use id, because a transcript can hold the same record twice.
        Set<String> workflowIds = new LinkedHashSet<>();
        int idlessWorkflowCalls = 0;
        String firstPrompt = null;

        try (BufferedReader reader = Files.newBufferedReader(file, StandardCharsets.UTF_8)) {
            String line;
            while ((line = reader.readLine()) != null) {
                if (line.isBlank()) {
                    continue;
                }
                JsonNode record;
                try {
                    record = MAPPER.readTree(line);
                } catch (IOException torn) {
                    continue; // a half-written last line is normal on a live session
                }
                JsonNode message = record.path("message");
                String model = message.path("model").asText(null);
                if (model != null && !model.isBlank()) {
                    models.add(model);
                }
                idlessWorkflowCalls += collectWorkflowCalls(message, workflowIds);
                if (firstPrompt == null && isUserPrompt(record)) {
                    firstPrompt = textOf(message.path("content"));
                }
            }
        } catch (IOException | RuntimeException unreadable) {
            return Facts.none(null);
        }

        return new Facts(
                null,
                List.copyOf(models),
                workflowIds.size() + idlessWorkflowCalls,
                0, // sidecar counts are ask-time facts; the caller stamps them on
                0,
                languageOf(firstPrompt),
                bound(firstPrompt));
    }

    /**
     * A real operator prompt, as opposed to the other three things Claude Code
     * writes as {@code type: "user"}: a tool result, a meta note, and a
     * tool-sourced injection. Checked against the newer {@code promptSource}
     * marker on the 25 largest real transcripts; the two agree on all of them,
     * and this form also reads transcripts written before that field existed.
     *
     * @param record one parsed transcript line
     * @return true when the operator typed it
     */
    private static boolean isUserPrompt(JsonNode record) {
        return "user".equals(record.path("type").asText())
                && !record.path("isMeta").asBoolean(false)
                && record.path("toolUseResult").isMissingNode()
                && record.path("sourceToolUseID").isMissingNode();
    }

    /**
     * Workflow tool calls in one message's content blocks, counted by IDENTITY.
     *
     * <p>A transcript can hold the same record twice — same uuid, same message
     * id, byte-identical content, the second copy differing only by an added
     * {@code slug} key. Measured over this store: 322 repeated records across
     * 11 of the 171 session transcripts, and in two of them the repeated record
     * carries a Workflow block, so the row said one workflow more than the
     * session ran. One {@code tool_use} id is one call, however many lines the
     * file writes it on.</p>
     *
     * <p>A block with no id cannot be PROVEN a duplicate of anything, so it is
     * counted straight. Undercounting a real call is the worse of the two
     * errors, and the de-duplication must not reach past its evidence.</p>
     *
     * @param message the {@code message} node, possibly missing
     * @param ids collects the ids seen so far — the caller owns it across lines
     * @return how many Workflow blocks carried no id, to be added on top
     */
    private static int collectWorkflowCalls(JsonNode message, Set<String> ids) {
        JsonNode content = message.path("content");
        if (!content.isArray()) {
            return 0;
        }
        int idless = 0;
        for (JsonNode block : content) {
            if (!"tool_use".equals(block.path("type").asText())
                    || !"Workflow".equals(block.path("name").asText())) {
                continue;
            }
            String id = block.path("id").asText(null);
            if (id == null || id.isBlank()) {
                idless++;
            } else {
                ids.add(id);
            }
        }
        return idless;
    }

    /**
     * The text of a message body, which is a bare string in older transcripts
     * and a block list in newer ones.
     *
     * @param content the {@code content} node
     * @return the joined text, or null when there is none
     */
    private static String textOf(JsonNode content) {
        if (content.isTextual()) {
            return blankToNull(content.asText());
        }
        if (!content.isArray()) {
            return null;
        }
        StringBuilder text = new StringBuilder();
        for (JsonNode block : content) {
            if ("text".equals(block.path("type").asText())) {
                if (text.length() > 0) {
                    text.append('\n');
                }
                text.append(block.path("text").asText(""));
            }
        }
        return blankToNull(text.toString());
    }

    /**
     * How deep below {@code subagents/} the walk looks for workflow agents.
     * The real layout is {@code subagents/workflows/<runId>/agent-*.jsonl},
     * three levels; one more is headroom for a nested run dir, and a hard
     * ceiling because this store is somebody else's and a pathological tree
     * must cost a bounded listing, not a crawl.
     */
    private static final int SIDECAR_DEPTH = 4;

    /**
     * Both agent populations in the session's sidecar folder, which sits beside
     * the transcript under its own name. Only {@code agent-*.jsonl} counts:
     * each agent also writes a {@code .meta.json}, and a workflow run keeps a
     * {@code journal.jsonl}; counting either would inflate every number.
     *
     * <p>Called at ask time, never from the fold, because these counts must not
     * be cached under the transcript's stamp: agents accrue in this folder
     * while the parent transcript sits unchanged, and the stale answer was a
     * live-proven defect. The price is a directory walk per ask, which is the
     * cheap kind of filesystem work the whole facts endpoint exists to protect.</p>
     *
     * @param file the transcript path
     * @return both counts, {@link Sidecars#NONE} when there is no sidecar folder
     */
    static Sidecars sidecarsBeside(Path file) {
        String name = file.getFileName().toString();
        Path parent = file.getParent();
        if (parent == null || !name.endsWith(".jsonl")) {
            return Sidecars.NONE;
        }
        Path folder = parent.resolve(name.substring(0, name.length() - ".jsonl".length()))
                .resolve("subagents");
        if (!Files.isDirectory(folder)) {
            return Sidecars.NONE;
        }
        int direct = 0;
        int workflow = 0;
        try (Stream<Path> walk = Files.walk(folder, SIDECAR_DEPTH)) {
            for (Path entry : (Iterable<Path>) walk::iterator) {
                String base = entry.getFileName().toString();
                if (!base.startsWith("agent-") || !base.endsWith(".jsonl")
                        || !Files.isRegularFile(entry)) {
                    continue;
                }
                if (folder.equals(entry.getParent())) {
                    direct++;
                } else {
                    workflow++;
                }
            }
        } catch (IOException unreadable) {
            return Sidecars.NONE;
        }
        return new Sidecars(direct, workflow);
    }

    /** German function words that rarely survive into an English sentence. */
    private static final Set<String> GERMAN = Set.of(
            "der", "die", "das", "den", "dem", "des", "und", "oder", "aber", "nicht", "ist", "sind",
            "war", "ein", "eine", "einen", "einem", "einer", "mit", "für", "von", "auf", "aus",
            "bei", "nach", "noch", "schon", "auch", "nur", "sich", "ich", "du", "wir", "ihr",
            "mir", "mich", "dir", "sie", "wie", "was", "wenn", "dann", "bitte", "mach", "machen",
            "sag", "lies", "soll", "kann", "muss", "sehr", "mehr", "immer", "wieder", "alle",
            "alles", "etwas", "dass", "weil", "über", "unter", "zwischen", "durch", "gegen",
            "ohne", "damit", "warum", "wo", "wer", "welche", "hier", "dort", "jetzt", "heute");

    /** English function words, the same kind of marker on the other side. */
    private static final Set<String> ENGLISH = Set.of(
            "the", "and", "or", "but", "not", "is", "are", "was", "were", "a", "an", "with",
            "for", "from", "on", "of", "to", "in", "at", "by", "after", "still", "already",
            "also", "only", "i", "you", "we", "they", "me", "my", "your", "how", "what", "when",
            "then", "please", "make", "read", "should", "can", "must", "very", "more", "always",
            "again", "all", "everything", "something", "that", "because", "about", "under",
            "between", "through", "against", "without", "why", "where", "who", "which", "here",
            "there", "now", "today", "this", "it", "be", "have", "has", "do", "does", "tell",
            "missing", "card", "say");

    /**
     * Which language the operator typed in, decided locally by counting function
     * words. No model call: this runs on every listed row, and a per-row model
     * call would cost more than reading the transcripts did.
     *
     * <p>Silent by design when it does not know. A short prompt, a code
     * fragment or a pasted stack trace produces no verdict rather than a coin
     * flip, because a wrong flag on a row is worse than a blank one.</p>
     *
     * @param prompt the opening prompt, possibly null
     * @return {@code "de"}, {@code "en"}, or null
     */
    private static String languageOf(String prompt) {
        if (prompt == null) {
            return null;
        }
        String[] words = prompt.toLowerCase(Locale.ROOT).split("[^\\p{L}]+");
        List<String> real = new ArrayList<>();
        for (String word : words) {
            if (!word.isEmpty()) {
                real.add(word);
            }
        }
        if (real.size() < MIN_WORDS_TO_JUDGE) {
            return null;
        }
        int german = 0;
        int english = 0;
        for (String word : real) {
            if (GERMAN.contains(word)) {
                german++;
            }
            if (ENGLISH.contains(word)) {
                english++;
            }
        }
        if (german >= MIN_MARKERS_TO_JUDGE && german > english) {
            return "de";
        }
        if (english >= MIN_MARKERS_TO_JUDGE && english > german) {
            return "en";
        }
        return null;
    }

    /**
     * Trims a prompt to row length. The cut is marked, because a prompt that
     * silently stops is a prompt the reader will quote wrongly.
     *
     * @param prompt the prompt, possibly null
     * @return the bounded prompt, or null
     */
    private static String bound(String prompt) {
        if (prompt == null) {
            return null;
        }
        String flat = prompt.strip();
        if (flat.length() <= MAX_PROMPT_CHARS) {
            return blankToNull(flat);
        }
        return flat.substring(0, MAX_PROMPT_CHARS - 1) + "…";
    }

    private static String blankToNull(String text) {
        return text == null || text.isBlank() ? null : text;
    }
}
