package dev.spectroscope.server;

import com.fasterxml.jackson.annotation.JsonInclude;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;

import java.io.BufferedReader;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.DirectoryStream;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Locale;
import java.util.Set;

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
     * @param subagents agent transcripts in the session's sidecar folder
     * @param language {@code "de"}, {@code "en"}, or null when the prompts do not say
     * @param firstPrompt the opening user prompt, verbatim and bounded, or null
     */
    @JsonInclude(JsonInclude.Include.NON_NULL)
    record Facts(
            String path,
            List<String> models,
            int workflowCalls,
            int subagents,
            String language,
            String firstPrompt) {

        /** The empty answer for a file that could not be read. */
        static Facts none(String path) {
            return new Facts(path, List.of(), 0, 0, null, null);
        }

        /** Re-labels a folded answer with the path the caller asked under. */
        Facts at(String path) {
            return new Facts(path, models, workflowCalls, subagents, language, firstPrompt);
        }
    }

    /**
     * Folds one transcript, sidecars included.
     *
     * @param file the absolute transcript path
     * @return the facts; never null, never throwing
     */
    static Facts fold(Path file) {
        Set<String> models = new LinkedHashSet<>();
        int workflowCalls = 0;
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
                workflowCalls += workflowCallsIn(message);
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
                workflowCalls,
                subagentsBeside(file),
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
     * Workflow tool calls in one message's content blocks.
     *
     * @param message the {@code message} node, possibly missing
     * @return how many blocks are a Workflow tool call
     */
    private static int workflowCallsIn(JsonNode message) {
        JsonNode content = message.path("content");
        if (!content.isArray()) {
            return 0;
        }
        int calls = 0;
        for (JsonNode block : content) {
            if ("tool_use".equals(block.path("type").asText())
                    && "Workflow".equals(block.path("name").asText())) {
                calls++;
            }
        }
        return calls;
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
     * Agent transcripts in the session's sidecar folder, which sits beside the
     * transcript under its own name. Only {@code agent-*.jsonl} counts: each
     * agent also writes a {@code .meta.json}, and counting that would double
     * every number.
     *
     * @param file the transcript path
     * @return how many agents this session spawned, 0 when it spawned none
     */
    private static int subagentsBeside(Path file) {
        String name = file.getFileName().toString();
        Path parent = file.getParent();
        if (parent == null || !name.endsWith(".jsonl")) {
            return 0;
        }
        Path folder = parent.resolve(name.substring(0, name.length() - ".jsonl".length()))
                .resolve("subagents");
        if (!Files.isDirectory(folder)) {
            return 0;
        }
        int agents = 0;
        try (DirectoryStream<Path> entries = Files.newDirectoryStream(folder, "agent-*.jsonl")) {
            for (Path ignored : entries) {
                agents++;
            }
        } catch (IOException unreadable) {
            return 0;
        }
        return agents;
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
