package dev.spectroscope.core.tools;

import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import dev.spectroscope.core.Asker;
import dev.spectroscope.core.CancelSignal;
import dev.spectroscope.core.events.RunEvent;

import java.util.ArrayList;
import java.util.List;

/**
 * The {@code ask_user_question} tool: the run stops, asks a person a
 * multiple-choice question, and carries on with the answer.
 *
 * <p>Permission-free, and that is a decision rather than an oversight. The
 * gate's own criterion is "side effects on untrusted input"; a question has no
 * side effect, and gating it would produce two prompts in a row for one
 * interaction — a permission dialog asking whether the agent may ask you
 * something.</p>
 *
 * <p><b>The park happens inside {@code execute}</b>, on the same virtual thread
 * the permission gate already parks. That is what makes the clock matter: card
 * 111 separated the operator's wait from the tool's own work once, for the gate,
 * and a four-minute answer recorded as a four-minute tool call would put that
 * lie back into every duration readout in the app. So this tool measures its
 * park and reports it through {@link Tool.ToolContext#waitReport()}; the loop
 * subtracts it, and the wait travels on {@code question_answered.waitMs}.</p>
 *
 * <p><b>Nothing here ever invents an answer.</b> A cancelled run, an asker that
 * returns null (a closed socket, an unattended permission mode, a face with
 * nobody attached) all produce the same honest outcome: a
 * {@code question_answered} marked cancelled, and a result the model can act on
 * that carries no {@code ERROR:} prefix — a question nobody heard is not a tool
 * failure and must not invite a retry. Never throws.</p>
 */
public final class AskUserQuestionTool implements Tool {

    private static final ObjectMapper JSON = new ObjectMapper();

    /** How long one question may be. A question is read under time pressure. */
    public static final int MAX_QUESTION_CHARS = 500;
    /** How many choices one question may offer — the bar renders them in a row. */
    public static final int MAX_OPTIONS = 4;
    /** How long one option label may be. */
    public static final int MAX_OPTION_CHARS = 100;
    /**
     * How many questions one run may ask. A model that discovers it can stall a
     * run by asking must not be able to loop, and three is the concept's number:
     * enough for a genuine fork in the work, far short of a conversation.
     */
    public static final int QUESTIONS_PER_RUN = 3;

    /** The importer's own input shape, verbatim (toolViews.ts reads exactly this),
     *  so a native question renders identically to one read out of a foreign
     *  transcript — and the finished card came for free. */
    private static final JsonNode SCHEMA = parseSchema("""
            { "type": "object", "required": ["questions"],
              "properties": {
                "questions": {
                  "type": "array",
                  "description": "Exactly one question. Ask again later for a second one.",
                  "items": {
                    "type": "object",
                    "required": ["question", "options"],
                    "properties": {
                      "question":    { "type": "string",
                                       "description": "The question, in plain text, max 500 characters" },
                      "header":      { "type": "string",
                                       "description": "A short label above it, e.g. \\"Storage\\"" },
                      "multiSelect": { "type": "boolean",
                                       "description": "Whether more than one option may be chosen" },
                      "options": {
                        "type": "array",
                        "description": "One to four choices",
                        "items": {
                          "type": "object",
                          "required": ["label"],
                          "properties": {
                            "label":       { "type": "string",
                                             "description": "The choice, max 100 characters" },
                            "description": { "type": "string",
                                             "description": "One line of help for this choice" } } } } } } } } }
            """);

    private final Asker asker;

    /**
     * The seam by constructor at registration, exactly as {@code WebFetchTool}
     * takes its fetcher — nothing about the ask reaches {@code AgentOptions},
     * the {@code Agent} builder or the frozen facade.
     *
     * @param asker who is asked; {@link Asker#none()} where nobody is attached
     */
    public AskUserQuestionTool(Asker asker) {
        this.asker = asker;
    }

    /**
     * The run this tool is counting questions for, held by identity: a
     * {@link CancelSignal} IS a run's lifetime object, so a new run is a new
     * signal and gets a fresh budget without any run id being threaded into the
     * tool. Guarded by {@code this}, and safe because the asks of one agent are
     * sequential by construction — each one parks the loop that would issue the
     * next.
     */
    private CancelSignal countingFor;
    private int askedThisRun;

    /** Wire name: {@code ask_user_question} — the importer's tool under our own naming. */
    @Override
    public String name() {
        return "ask_user_question";
    }

    /** The model-facing manual — the only text the model has to decide when to call. */
    @Override
    public String description() {
        return "Asks the person watching this run one multiple-choice question and waits for "
                + "the answer. Use it for a decision only they can make — which of two designs, "
                + "which environment, whether a destructive step is really wanted — instead of "
                + "guessing and building the wrong thing. One question per call, up to four "
                + "options, and they may also answer in their own words. If the reply says "
                + "\"unanswered\", nobody was there: say which assumption you are proceeding "
                + "with and carry on, do not call again for the same thing. Never ask for a "
                + "credential, key or password — the answer is written into this session's "
                + "transcript, and keys have their own path that never echoes them.";
    }

    /** Requires a {@code questions} array holding exactly one question. */
    @Override
    public JsonNode inputSchema() {
        return SCHEMA;
    }

    /** Permission-free: a question has no side effect, and gating it would be two
     *  prompts for one interaction. */
    @Override
    public boolean needsPermission() {
        return false;
    }

    /**
     * Validates the call, spends one of the run's questions, publishes the
     * question, parks on the person, and publishes what came back.
     *
     * @param input   the model-supplied call in the importer's shape
     * @param context the loop's per-call environment — emit sink, cancel signal, wait sink
     * @return the answer as prose the transcript renderer can read, an
     *         {@code unanswered:} line when nobody answered, or an
     *         {@code ERROR:} string when the call itself was refused
     */
    @Override
    public String execute(JsonNode input, ToolContext context) {
        JsonNode questions = input.path("questions");
        if (!questions.isArray() || questions.isEmpty()) {
            return "ERROR: questions must be an array holding one question "
                    + "({question, header, multiSelect, options:[{label, description}]}).";
        }
        if (questions.size() > 1) {
            return "ERROR: ask one question per call; this call carried " + questions.size()
                    + ". Ask the next one after this answer.";
        }
        JsonNode entry = questions.get(0);
        String text = entry.path("question").asText("").strip();
        if (text.isBlank()) {
            return "ERROR: the question needs non-empty text.";
        }
        if (text.length() > MAX_QUESTION_CHARS) {
            return "ERROR: the question is " + text.length() + " characters; the limit is "
                    + MAX_QUESTION_CHARS + ". Ask a shorter one — it is read under time pressure.";
        }
        JsonNode optionNodes = entry.path("options");
        if (!optionNodes.isArray() || optionNodes.isEmpty()) {
            return "ERROR: offer between 1 and " + MAX_OPTIONS + " options — a question with "
                    + "nothing to pick is a message, not a question.";
        }
        if (optionNodes.size() > MAX_OPTIONS) {
            return "ERROR: " + optionNodes.size() + " options; the limit is " + MAX_OPTIONS + ".";
        }
        List<RunEvent.QuestionOption> options = new ArrayList<>();
        for (JsonNode optionNode : optionNodes) {
            String label = optionNode.path("label").asText("").strip();
            if (label.isBlank()) {
                return "ERROR: every option needs a non-empty \"label\".";
            }
            if (label.length() > MAX_OPTION_CHARS) {
                return "ERROR: the option \"" + label.substring(0, MAX_OPTION_CHARS) + "…\" is "
                        + label.length() + " characters; the limit is " + MAX_OPTION_CHARS + ".";
            }
            String help = optionNode.path("description").asText("").strip();
            options.add(new RunEvent.QuestionOption(label, help.isBlank() ? null : help));
        }
        // Spent AFTER the bounds, so a malformed call costs nothing: the model
        // gets a refusal it can correct, and the person is still owed a question.
        if (!spendOneQuestion(context.signal())) {
            return "ERROR: question budget spent for this run (" + QUESTIONS_PER_RUN
                    + " questions). Decide with what you have and say what you assumed.";
        }

        String header = entry.path("header").asText("").strip();
        RunEvent.QuestionAsked question = new RunEvent.QuestionAsked(
                context.agentId(), context.callId(),
                List.of(new RunEvent.AskedQuestion(text, header.isBlank() ? null : header,
                        entry.path("multiSelect").asBoolean(false), List.copyOf(options))),
                System.currentTimeMillis());
        context.emit().accept(question);

        // Release path 1, before anything parks: a run already cancelled must not
        // reach a person at all. The remaining three live in the asker (a closed
        // socket, an unattended mode, a face with nobody attached) and all of
        // them arrive here as the same null.
        long parkedAt = System.currentTimeMillis();
        Asker.Answer answer = context.signal() != null && context.signal().isCancelled()
                ? null
                : askQuietly(question);
        long waitedMs = System.currentTimeMillis() - parkedAt;
        context.waitReport().accept(waitedMs);

        List<String> answers = answer == null ? List.of() : answer.answers();
        context.emit().accept(new RunEvent.QuestionAnswered(context.callId(), answers,
                answer == null, waitedMs, System.currentTimeMillis()));
        if (answer == null) {
            return "unanswered: nobody answered this question. State the assumption you are "
                    + "proceeding with and carry on.";
        }
        return reply(text, answers);
    }

    /**
     * Parks on the person; an asker that throws is a face that broke, not an
     * answer. The tool contract forbids throwing, and inventing a reply here
     * would be worse than saying nobody answered.
     *
     * @param question what to ask
     * @return the answer, or null when nobody could be asked
     */
    private Asker.Answer askQuietly(RunEvent.QuestionAsked question) {
        try {
            return asker.ask(question);
        } catch (RuntimeException broken) {
            return null;
        }
    }

    /**
     * The answer as the transcript renderer already reads it:
     * {@code "<question>"="<answer>"}. Not decoration — {@code toolViews.ts}
     * locates an answer by that anchor and marks the chosen option off it, which
     * is what makes a native question read exactly like an imported one. Nothing
     * after the closing quote may itself contain a quote: the reader takes the
     * LAST one as the answer's end, because an answer is allowed to quote things.
     *
     * @param question the question text, verbatim — it is the anchor
     * @param answers  what came back, one entry per question
     * @return one line of prose for the model and the card
     */
    private static String reply(String question, List<String> answers) {
        String answer = answers.isEmpty() ? "" : answers.get(0);
        return "The user answered: \"" + question + "\"=\"" + answer
                + "\". Continue with that answer.";
    }

    /**
     * Takes one question off this run's budget.
     *
     * @param signal the run's cancel signal, used as the run's identity
     * @return true when the question may be asked
     */
    private synchronized boolean spendOneQuestion(CancelSignal signal) {
        if (signal != countingFor) {
            countingFor = signal;
            askedThisRun = 0;
        }
        askedThisRun++;
        return askedThisRun <= QUESTIONS_PER_RUN;
    }

    /**
     * Parses the built-in schema literal — a broken one is a programming error and
     * fails loudly at class-initialization time.
     *
     * @param json the JSON Schema source text
     * @return the parsed schema tree
     */
    private static JsonNode parseSchema(String json) {
        try {
            return JSON.readTree(json);
        } catch (JsonProcessingException invalid) {
            throw new IllegalStateException("Invalid built-in tool schema: " + invalid.getMessage(), invalid);
        }
    }
}
