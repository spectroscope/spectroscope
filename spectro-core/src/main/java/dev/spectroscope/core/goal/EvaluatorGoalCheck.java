package dev.spectroscope.core.goal;

import dev.spectroscope.core.config.governing.Governs;
import dev.spectroscope.core.provider.LlmProvider;
import dev.spectroscope.core.provider.LlmProvider.PTextDelta;
import dev.spectroscope.core.provider.LlmProvider.ProviderEvent;
import dev.spectroscope.core.provider.LlmProvider.ProviderMessage;
import dev.spectroscope.core.provider.LlmProvider.ProviderRequest;
import dev.spectroscope.core.provider.LlmProvider.TextContent;

import java.util.ArrayList;
import java.util.List;

/**
 * The opt-in teeth: a model judges the outcome against the transcript
 * (card 267, placement (b)).
 *
 * <p><b>This is not the default and must never become it by drift.</b> Nothing
 * in the house wires it; a face that wants it constructs it with a provider and
 * a model name it states out loud, which is the whole of owner call 1's answer
 * as decided while building. The reason is measured rather than felt: LM Studio
 * reports {@code trained_for_tool_use: false} for the loaded
 * {@code deepseek-v4-flash-0731@iq1_m}, so on the house backend the judge is
 * weaker than the worker it judges, and card 267 carries the number a critic
 * without teeth costs — 98 % baseline down to 57 %.</p>
 *
 * <p>Its verdict is therefore always attributed. {@link GoalVerdict#judge()}
 * carries the model name, {@link GoalVerdict#exitCode()} stays null, and a
 * reader can tell an exit code from an opinion without reading prose.</p>
 *
 * <p><b>An unparseable answer is UNTESTED, never MET.</b> A judge that rambles
 * has not judged. The one thing this class refuses to do is guess in the
 * permissive direction.</p>
 */
public final class EvaluatorGoalCheck implements GoalCheck {

    /** The verdict word the evaluator must answer with for a pass. */
    public static final String MET_WORD = "GOAL_MET";

    /** The verdict word for a fail. */
    public static final String UNMET_WORD = "GOAL_NOT_MET";

    /** The completion budget for one judgement — a verdict and a reason, not an essay. */
    @Governs(kind = Governs.Kind.FIXED, unit = Governs.Unit.TOKENS)
    private static final int MAX_TOKENS = 512;

    /** How many of the run's most recent messages the judge is shown. */
    @Governs(kind = Governs.Kind.FIXED, unit = Governs.Unit.COUNT)
    private static final int TRANSCRIPT_TAIL = 12;

    /** How much of one message's text the judge is shown. */
    @Governs(kind = Governs.Kind.FIXED, unit = Governs.Unit.CHARACTERS)
    private static final int MAX_MESSAGE_CHARS = 2_000;

    private static final String SYSTEM =
            "You are judging whether a stated outcome was reached. You are not helping and not"
                    + " continuing the work. Read the transcript, then answer with exactly one"
                    + " line: " + MET_WORD + " or " + UNMET_WORD + ", a space, and one sentence"
                    + " naming the evidence in the transcript you based it on. If the transcript"
                    + " does not contain evidence either way, answer " + UNMET_WORD + ".";

    private final LlmProvider provider;
    private final String model;

    /**
     * @param provider the backend the judgement is asked of
     * @param model    the model name recorded on every verdict this produces —
     *                 stated by whoever opted in, never inferred, so a verdict
     *                 can always be traced to the thing that made it
     */
    public EvaluatorGoalCheck(LlmProvider provider, String model) {
        this.provider = provider;
        this.model = model;
    }

    @Override
    public GoalVerdict run(RunGoal goal, Context context) {
        long startedAt = System.currentTimeMillis();
        List<ProviderMessage> shown = new ArrayList<>(tail(context.transcript() == null
                ? List.of() : context.transcript().get()));
        shown.add(new ProviderMessage(ProviderMessage.Role.USER, List.of(new TextContent(
                "The stated outcome was:\n\n" + goal.outcome().strip()
                        + "\n\nWas it reached? Answer with " + MET_WORD + " or "
                        + UNMET_WORD + " and one sentence."))));
        StringBuilder answer = new StringBuilder();
        try {
            for (ProviderEvent event : provider.stream(new ProviderRequest(
                    SYSTEM, shown, List.of(), MAX_TOKENS,
                    ProviderRequest.Reasoning.DEFAULT, null, context.signal(), null))) {
                if (event instanceof PTextDelta delta) {
                    answer.append(delta.text());
                }
            }
        } catch (RuntimeException failure) {
            return new GoalVerdict(GoalVerdict.Outcome.UNTESTED, null, null, "",
                    System.currentTimeMillis() - startedAt, null, model,
                    "untested: the evaluator " + model + " could not be asked — "
                            + failure.getMessage());
        }
        long durationMs = System.currentTimeMillis() - startedAt;
        String said = GoalVerdict.clip(answer.toString().strip());
        // UNMET IS TESTED FIRST, and the order is the whole safety property.
        // The system prompt asks for a verdict AND a reason, and a reason is
        // routinely about the evidence for the OTHER verdict — "GOAL_NOT_MET,
        // there is no GOAL_MET evidence in the transcript" is a well-formed
        // answer. Read MET-first, that sentence graded the run met, which is
        // this class's javadoc promise broken in the one direction it names.
        // Asymmetric on purpose: a permissive misread reports work as done that
        // is not, a strict one costs a continuation.
        if (said.contains(UNMET_WORD)) {
            return new GoalVerdict(GoalVerdict.Outcome.FAILED, null, null, said, durationMs, null,
                    model, "failed: the evaluator " + model + " answered " + UNMET_WORD);
        }
        if (said.contains(MET_WORD)) {
            return new GoalVerdict(GoalVerdict.Outcome.MET, null, null, said, durationMs, null,
                    model, "met: the evaluator " + model + " answered " + MET_WORD);
        }
        return new GoalVerdict(GoalVerdict.Outcome.UNTESTED, null, null, said, durationMs, null,
                model, "untested: the evaluator " + model + " answered with neither verdict word");
    }

    /** The most recent messages, each clipped — the judge reads the end of the
     *  run, which is where the evidence about the outcome is.
     *  @param all the run's history
     *  @return at most {@link #TRANSCRIPT_TAIL} messages, text only */
    private static List<ProviderMessage> tail(List<ProviderMessage> all) {
        List<ProviderMessage> out = new ArrayList<>();
        for (ProviderMessage message : all.subList(Math.max(0, all.size() - TRANSCRIPT_TAIL),
                all.size())) {
            StringBuilder text = new StringBuilder();
            message.content().forEach(part -> {
                if (part instanceof TextContent content) {
                    text.append(content.text()).append('\n');
                }
            });
            if (!text.isEmpty()) {
                String body = text.toString();
                out.add(new ProviderMessage(message.role(), List.of(new TextContent(
                        body.length() <= MAX_MESSAGE_CHARS
                                ? body : body.substring(0, MAX_MESSAGE_CHARS) + "…"))));
            }
        }
        return out;
    }
}
