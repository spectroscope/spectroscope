package dev.spectroscope.core.progress;

import com.fasterxml.jackson.databind.JsonNode;
import dev.spectroscope.core.Asker;
import dev.spectroscope.core.CancelSignal;
import dev.spectroscope.core.PlanVerdict;
import dev.spectroscope.core.events.RunEvent;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.ArrayList;
import java.util.EnumSet;
import java.util.HexFormat;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.Set;
import java.util.UUID;
import java.util.function.Consumer;

/**
 * The harness's own eye on a run that is not going anywhere (card 262).
 *
 * <p>Cut from a measurement, not a worry. On 2026-08-17 a local model wrote
 * {@code src/particleEngine.js} through {@code particleEngine31.js} — 31 files,
 * ONE distinct content, 283 bytes each — ran the same unsatisfiable test after
 * each copy, and spent about an hour doing it. Every signal was already in the
 * harness's hands: the tool calls, their inputs, the results. Nobody drew a
 * conclusion from the sequence.</p>
 *
 * <p><b>Three detectors, one verdict.</b> The owner chose every candidate the
 * card offered, so this is a family rather than a rule:</p>
 * <ol>
 *   <li>{@link Detector#IDENTICAL_WRITES} — the exact bytes of an earlier write
 *       going out under a new path, N times. One hash per write, and practically
 *       impossible to false-positive above
 *       {@link ProgressSettings#MIN_CONTENT_CHARS}. This is the detector that
 *       catches the measured loop.</li>
 *   <li>{@link Detector#REPEATED_FAILURE} — the same call, byte-identical input,
 *       failing N times in a row. Catches the same loop when the model varies
 *       the filename, which detector 1 would miss — and in the measured run it
 *       DID vary it (every round ran its own numbered test file), which is
 *       exactly why one detector was never enough.</li>
 *   <li>{@link Detector#STALLED_PLAN} — a plan that has not moved for N turns
 *       with steps still open. The third net, never the first, and off by
 *       default; the reason is written out in {@link ProgressSettings}.</li>
 * </ol>
 *
 * <p><b>What happens when one fires is the owner's decision, recorded on the
 * card before this was built: warn AND pause.</b> The run says what it saw, in
 * the operator's language and with the count, and then asks the person watching
 * whether to carry on, change course, or end it. The waiting mechanism is card
 * 265's ask, reused rather than reinvented — the same {@link Asker}, the same
 * {@code question_asked}/{@code question_answered} pair, the same park on a
 * virtual thread. A second waiting mechanism beside it would be two things that
 * can disagree about who is waiting.</p>
 *
 * <p><b>Nobody to ask is not a licence to abort, and it is not a "carry on"
 * either.</b> An asker that answers {@code null} — a closed socket, an
 * unattended permission mode, a face with no person — leaves the run going:
 * stopping a run on nobody's word would be the silent abort criterion 3 forbids.
 * But the detector stays UP and only its memory is cleared. Treating an absent
 * person as an approving one turned the owner's "warn AND pause" into "warn once
 * and go deaf" in permission mode {@code auto} — plausibly the mode the measured
 * loop ran in — so an hour of copies would have left ONE line. The cost is
 * stated: an unattended run that really does repeat itself writes a line every N
 * events rather than one, which is a transcript that shows the loop continuing.</p>
 *
 * <p><b>What a "carry on" and a "change course" cost afterwards</b>, because
 * they are not the same promise. Carry on stands that detector down for the rest
 * of the run: the person looked and said it is fine, and a guard that asks again
 * about the thing it was just told to ignore is a guard people mute. Change
 * course only CLEARS that detector's memory: the model has been steered, and if
 * it walks straight back into the same loop it has to earn a full N again before
 * the person is bothered a second time.</p>
 *
 * <p><b>Everything it remembers belongs to the RUN, not to the agent</b>, and
 * that is the whole of {@link #startRun()}. One agent serves many prompts — a
 * browser session builds its agent once and never again, and the REPL rebuilds
 * only on {@code /think} — so a memory that outlived the run would add four
 * honest prompts into a strike (criterion 5 broken by construction), and one
 * "carry on" would deafen the detector for the whole session. Both were measured
 * in this branch's review before the reset existed.</p>
 *
 * <p>Not thread-safe, and it does not need to be: one guard belongs to one
 * agent's loop, which is sequential by construction.</p>
 */
public final class ProgressGuard {

    /** Which of the three nets caught it. Pinned on by tests: the prose beside
     *  it is written for a person and may be reworded, this may not. */
    public enum Detector {
        /** The exact bytes of an earlier write, going out under a new path. */
        IDENTICAL_WRITES("identical_writes"),
        /** One call with byte-identical input, failing again and again. */
        REPEATED_FAILURE("repeated_failure"),
        /** A plan with open steps that has not moved for N turns. */
        STALLED_PLAN("stalled_plan");

        private final String wireName;

        Detector(String wireName) {
            this.wireName = wireName;
        }

        /** The stable snake_case name that travels on the wire.
         *  @return {@code identical_writes}, {@code repeated_failure} or {@code stalled_plan} */
        public String wireName() {
            return wireName;
        }
    }

    /**
     * What one detector saw, the moment it saw it.
     *
     * @param detector which net caught it
     * @param count    how many times the thing happened — the number the sentence says
     * @param evidence one sentence in the operator's language naming what was
     *                 seen. A guard that says "no progress" without naming the
     *                 evidence is a guess wearing a warning's clothes
     * @param details  the same facts unprosed, for a surface that writes its own
     *                 sentence in its own language; may be empty
     */
    public record Strike(Detector detector, int count, String evidence, List<String> details) {

        /** Defensive copy, and an empty list rather than null for a detector with
         *  nothing to list. */
        public Strike {
            details = details == null ? List.of() : List.copyOf(details);
        }

        /** A strike with no supporting list — the shape the tests of the
         *  intervention half use, where only the sentence matters.
         *
         *  @param detector which net caught it
         *  @param count    how many times the thing happened
         *  @param evidence the sentence */
        public Strike(Detector detector, int count, String evidence) {
            this(detector, count, evidence, List.of());
        }
    }

    /** What the person watching decided. */
    public enum Intervention {
        /** Keep going, unchanged. When a PERSON said it, that detector stands
         *  down for the rest of the run; when nobody was there to say it, only
         *  the detector's memory is cleared and the net stays up. */
        CARRY_ON,
        /** Do not do that; here is what to do instead. The call is not executed. */
        CHANGE_COURSE,
        /** Stop the run here. */
        END
    }

    /**
     * The decision plus the words that carry it back to the model.
     *
     * @param intervention what happens next
     * @param guidance     what the model is told; null exactly for
     *                     {@link Intervention#CARRY_ON}, which changes nothing
     *                     and therefore says nothing
     */
    public record Response(Intervention intervention, String guidance) {}

    /** The first option: keep going, unchanged. */
    public static final String CARRY_ON_LABEL = "Carry on";
    /** The middle option: stop this step, the operator says what to do instead. */
    public static final String CHANGE_COURSE_LABEL = "Change course";
    /** The last option: stop the run here. */
    public static final String END_LABEL = "End the run";

    /** The label above the question, so the bar is recognisable at a glance. */
    private static final String HEADER = "No progress";

    /**
     * {@code run_end.stopReason} for a run the operator ended at the guard's
     * question.
     *
     * <p>A VALUE on the existing field, never a new field — the same rule card
     * 264 followed for {@code unfinished}, so a line written today is
     * shape-identical to one written by v0.1.0. "The run just stopped" is the
     * one thing an observability product must not say.</p>
     */
    public static final String STOP_REASON = "no_progress";

    /** How much of one detector's memory is kept. {@link #startRun()} empties it
     *  between runs, but one run can itself write thousands of files, and a
     *  guard that remembers all of them is a leak inside it. Eviction is
     *  oldest-first and costs only the ability to notice a repeat older than
     *  this many distinct contents — which is not the failure mode this guards. */
    static final int MEMORY = 512;

    /** The question must stay readable under time pressure; card 265 caps its
     *  own tool at 500 characters and this question travels the same bar. */
    private static final int MAX_QUESTION_CHARS = 500;

    /** How much of the "already written to" list the SENTENCE carries. The
     *  structured details carry all of them; this is the prose budget. */
    private static final int MAX_PATH_LIST_CHARS = 160;

    private final ProgressSettings settings;
    private final Asker asker;

    /** content hash → the distinct paths that content has already been written to. */
    private final Map<String, Set<String>> pathsByContent = boundedMap();
    /** how many bytes each remembered content had — for the sentence. */
    private final Map<String, Integer> sizeByContent = boundedMap();
    /** tool name + input → how many times in a row it has failed. */
    private final Map<String, Integer> failuresInARow = boundedMap();

    private String planSignature;
    private int planUnchangedTurns;

    /** Detectors already answered for, which must stay quiet for this run. */
    private final Set<Detector> stoodDown = EnumSet.noneOf(Detector.class);

    /**
     * @param settings the thresholds; {@link ProgressSettings#off()} makes every
     *                 observation a no-op
     * @param asker    who is asked when a detector fires; {@link Asker#none()}
     *                 where nobody is attached, which makes the guard warn once
     *                 per detector and carry on
     */
    public ProgressGuard(ProgressSettings settings, Asker asker) {
        this.settings = settings;
        this.asker = asker;
    }

    /** The thresholds this guard runs on.
     *  @return the settings it was built with */
    public ProgressSettings settings() {
        return settings;
    }

    /**
     * Forgets everything the last run taught it. Called by the loop at the top
     * of every run, before {@code run_start} goes out.
     *
     * <p>The four memories AND the stand-down, because both halves are sentences
     * about one run: "the same bytes three times" is a claim about a task, and
     * "carry on" is a person answering about the task in front of them. An agent
     * is not a task — {@code SessionConnection.buildAgentOnce} returns the same
     * agent for every prompt of a browser session — so without this a session's
     * fourth honest write is a strike and its first wave-through is permanent.</p>
     */
    public void startRun() {
        pathsByContent.clear();
        sizeByContent.clear();
        failuresInARow.clear();
        planSignature = null;
        planUnchangedTurns = 0;
        stoodDown.clear();
    }

    /**
     * Detector 1, asked BEFORE the call runs.
     *
     * <p>Before, because the scenario on the card says the transcript speaks
     * when the fourth copy STARTS. A guard that fires after the write has landed
     * is a report; this one can still stop the write.</p>
     *
     * <p>Keyed on shape, not on a tool-name allowlist: any call carrying a
     * textual {@code path} and a textual {@code content} is a write, which is
     * {@code write_file}'s own schema and the shape most MCP file servers copy.
     * {@code edit_file} is deliberately out — it carries {@code old_string} and
     * {@code new_string} rather than the finished bytes, so there is nothing
     * here to compare.</p>
     *
     * @param toolName the tool about to run
     * @param input    the model-supplied input, untrusted
     * @return the strike, or empty
     */
    public Optional<Strike> observeCall(String toolName, JsonNode input) {
        if (settings.identicalWrites() <= 0 || stoodDown.contains(Detector.IDENTICAL_WRITES)
                || input == null) {
            return Optional.empty();
        }
        JsonNode pathNode = input.path("path");
        JsonNode contentNode = input.path("content");
        if (!pathNode.isTextual() || !contentNode.isTextual()) {
            return Optional.empty();
        }
        String content = contentNode.asText();
        if (content.length() < ProgressSettings.MIN_CONTENT_CHARS) {
            return Optional.empty();
        }
        String path = pathNode.asText();
        String digest = sha256(content);
        Set<String> earlier = pathsByContent.computeIfAbsent(digest, key -> new LinkedHashSet<>());
        sizeByContent.put(digest, content.getBytes(StandardCharsets.UTF_8).length);
        if (earlier.contains(path)) {
            // The same path rewritten is not a copy. Card 269 already answers
            // "did that write change anything" on the result; this detector is
            // only ever about the SAME bytes appearing under a NEW name.
            return Optional.empty();
        }
        if (earlier.size() >= settings.identicalWrites()) {
            List<String> details = new ArrayList<>(earlier);
            details.add(path); // last entry is the copy that was starting
            int bytes = sizeByContent.getOrDefault(digest, content.length());
            // Clipped, both halves: the threshold is the operator's number, and
            // at 60 the joined list is a paragraph on a wire that feeds a
            // terminal line and an ask bar. Nothing is lost — `details` carries
            // every path unprosed, which is what it is for.
            return Optional.of(new Strike(Detector.IDENTICAL_WRITES, earlier.size(),
                    "The same " + bytes + " bytes have already gone to " + earlier.size()
                            + " paths (" + clip(String.join(", ", earlier), MAX_PATH_LIST_CHARS)
                            + "), and another copy is starting: " + clip(path) + ".",
                    details));
        }
        earlier.add(path);
        return Optional.empty();
    }

    /**
     * Detector 2, asked after a call came back.
     *
     * <p>Criterion 5 binds this one: a flaky test that fails twice and then
     * passes must NOT fire, so the counter is reset by any success of the same
     * call rather than merely decayed, and the input must match byte for byte.
     * A model working through twelve different failing tests keys twelve
     * different counters and never accumulates.</p>
     *
     * @param toolName the tool that ran
     * @param input    the input it ran with
     * @param isError  whether the loop is about to report this result as an error
     * @return the strike, or empty
     */
    public Optional<Strike> observeResult(String toolName, JsonNode input, boolean isError) {
        if (settings.repeatedFailures() <= 0 || stoodDown.contains(Detector.REPEATED_FAILURE)) {
            return Optional.empty();
        }
        // Tab-joined, and the separator is not decoration: without one, a tool
        // named `run` with input `x` and a tool named `ru` with input `nx` share
        // a counter, and two unrelated calls add up to a strike.
        String key = toolName + "\t" + (input == null ? "" : input.toString());
        if (!isError) {
            failuresInARow.remove(key);
            return Optional.empty();
        }
        int failures = failuresInARow.merge(key, 1, Integer::sum);
        if (failures < settings.repeatedFailures()) {
            return Optional.empty();
        }
        String call = callSummary(toolName, input);
        return Optional.of(new Strike(Detector.REPEATED_FAILURE, failures,
                "The same call has failed " + failures + " times in a row with byte-identical"
                        + " input: " + call + ".",
                List.of(call)));
    }

    /**
     * Detector 3, asked once per turn before the provider is called.
     *
     * <p>Its precondition is stated rather than assumed: it needs a plan that
     * exists and is maintained. A weak local model often keeps none — LM Studio
     * reports the owner's model {@code trained_for_tool_use: false}, so it is
     * handed no tool belt at all and can never call {@code update_plan} — and
     * that is exactly the run this guard exists for. Silent by construction
     * there, and never the only thing standing.</p>
     *
     * <p>A plan whose steps are ALL completed cannot stall either: a run that
     * finished its list and spends two turns writing its summary has not
     * stopped moving, it has stopped having anything left to move.</p>
     *
     * @param plan the newest plan this agent has written, or null when none
     * @return the strike, or empty
     */
    public Optional<Strike> observeTurn(RunEvent.Plan plan) {
        if (settings.stalledPlanTurns() <= 0 || stoodDown.contains(Detector.STALLED_PLAN)) {
            return Optional.empty();
        }
        if (plan == null || plan.steps() == null || plan.steps().isEmpty()) {
            planSignature = null;
            planUnchangedTurns = 0;
            return Optional.empty();
        }
        int open = PlanVerdict.openSteps(plan);
        // ONE definition of "the plan has not advanced", shared with card 266's
        // leash (PlanVerdict.planSignature). Two spellings of unchanged would
        // mean a run this guard calls stalled and the leash calls progress, in
        // the same turn, off the same ledger.
        String signature = PlanVerdict.planSignature(plan);
        if (!signature.equals(planSignature)) {
            planSignature = signature;
            planUnchangedTurns = 0;
            return Optional.empty();
        }
        if (open == 0) {
            return Optional.empty(); // finished work standing still is finished, not stalled
        }
        planUnchangedTurns++;
        if (planUnchangedTurns < settings.stalledPlanTurns()) {
            return Optional.empty();
        }
        List<String> openSteps = plan.steps().stream()
                .filter(step -> !"completed".equals(step.status()))
                .map(RunEvent.PlanStep::text)
                .toList();
        return Optional.of(new Strike(Detector.STALLED_PLAN, planUnchangedTurns,
                "The plan has not moved for " + planUnchangedTurns + " turns — " + open
                        + " of " + plan.steps().size() + " steps still open, same wording and"
                        + " same statuses.",
                openSteps));
    }

    /**
     * Says what was seen and asks the person what happens next.
     *
     * <p>The order matters and is pinned: {@code no_progress} goes out FIRST, so
     * a run cancelled while the question is parked still carries the
     * observation. Then the question, then the park, then the answer — card
     * 265's own sequence, driven from the loop instead of from a tool.</p>
     *
     * @param strike  what fired
     * @param agentId the agent the run belongs to, stamped on the events
     * @param emit    the loop's event sink
     * @param signal  the run's cancel signal — a cancelled run is never parked on
     * @return the decision and the words that carry it to the model
     */
    public Response intervene(Strike strike, String agentId,
                              Consumer<RunEvent> emit, CancelSignal signal) {
        long now = System.currentTimeMillis();
        // Card 281: minted BEFORE the observation, not after, so the line and the
        // bar it belongs to carry the same id. A run that fires twice draws two
        // of each, and without the id a surface has to pair them by guessing.
        String callId = "progress-" + UUID.randomUUID();
        emit.accept(new RunEvent.NoProgress(agentId, strike.detector().wireName(),
                strike.count(), strike.details().isEmpty() ? null : strike.details(),
                strike.evidence(), now, callId));

        RunEvent.QuestionAsked question = new RunEvent.QuestionAsked(agentId, callId,
                List.of(new RunEvent.AskedQuestion(questionText(strike), HEADER, false,
                        List.of(new RunEvent.QuestionOption(CARRY_ON_LABEL,
                                        "Nothing is wrong — keep going and stop watching for this."),
                                new RunEvent.QuestionOption(CHANGE_COURSE_LABEL,
                                        "Do not do that. Answer in your own words to say what instead."),
                                new RunEvent.QuestionOption(END_LABEL,
                                        "Stop the run here.")))),
                now);
        emit.accept(question);

        long parkedAt = System.currentTimeMillis();
        Asker.Answer answer = signal != null && signal.isCancelled() ? null : askQuietly(question);
        long waitedMs = System.currentTimeMillis() - parkedAt;
        List<String> answers = answer == null ? List.of() : answer.answers();
        emit.accept(new RunEvent.QuestionAnswered(callId, answers, answer == null,
                waitedMs, System.currentTimeMillis()));

        Response response = decide(strike, answers);
        // Card 281, criterion 6: what was CHOSEN, as the enum's own name and
        // bound to its ask. Emitted for every path including the unanswered one,
        // because "nobody was there" is itself a fact the transcript owes the
        // operator — a line that only appears when someone answered would read
        // as if the guard never fired in the unattended case the card was cut
        // from. stoodDown is display only and says whether this detector speaks
        // again in this run.
        boolean standsDown = answer != null && response.intervention() == Intervention.CARRY_ON;
        emit.accept(new RunEvent.ProgressIntervention(agentId, callId,
                strike.detector().wireName(), response.intervention().name(), standsDown,
                System.currentTimeMillis()));
        if (answer == null) {
            // NOBODY was there — a closed socket, an unattended permission mode,
            // a face with no person. That is not somebody saying "carry on", and
            // treating it as one turned "warn AND pause" into "warn once and go
            // deaf" in exactly the mode the measured loop plausibly ran in. The
            // net stays up and the memory goes, so the loop has to earn a full N
            // again: an unattended run that really is looping keeps saying so,
            // every N events, instead of mentioning it once in an hour.
            forget(strike.detector());
            return response;
        }
        switch (response.intervention()) {
            // Answered for BY A PERSON: they looked, so this detector has had its
            // say and stays quiet for the rest of the run.
            //
            // Card 281 sharpened this line, because it used to read "a skipped
            // question counts, the bar was in front of them" and that is true of
            // only ONE of the two things called a skip. An Answer that arrives
            // BLANK reaches here and does stand the detector down. The web's
            // Skip is not that: SessionConnection.onQuestionResponse maps it to
            // cancelled and hands the asker null, which never enters this switch
            // at all — it takes the branch above and leaves the net UP. The
            // owner ruled that this is the behaviour to keep, so what changed is
            // the sentence and not the code.
            case CARRY_ON -> stoodDown.add(strike.detector());
            // Steered: the memory goes, the net stays. A model that walks back
            // into the same loop earns a full N again before anyone is bothered.
            case CHANGE_COURSE -> forget(strike.detector());
            case END -> { /* the run is over; nothing to remember */ }
        }
        return response;
    }

    /** Parks on the person; an asker that throws is a face that broke, not an
     *  answer. Inventing a reply here would be worse than saying nobody answered.
     *  @param question what to ask
     *  @return the answer, or null when nobody could be asked */
    private Asker.Answer askQuietly(RunEvent.QuestionAsked question) {
        try {
            return asker.ask(question);
        } catch (RuntimeException broken) {
            return null;
        }
    }

    /**
     * Maps what a person said onto what happens next.
     *
     * <p>Anything that is not one of the three labels is treated as steering and
     * handed to the model verbatim — card 265 lets a person answer in their own
     * words, and words the model never reads are the same as no answer at all.
     * Nothing at all (nobody there, a released park) is CARRY_ON: ending a run
     * on nobody's word would be the silent abort criterion 3 forbids.</p>
     *
     * @param strike  what fired, for the sentence handed to the model
     * @param answers what came back, empty when nobody answered
     * @return the decision plus its guidance
     */
    private static Response decide(Strike strike, List<String> answers) {
        String said = String.join(", ", answers).strip();
        if (said.isBlank()) {
            return new Response(Intervention.CARRY_ON, null);
        }
        if (said.equalsIgnoreCase(CARRY_ON_LABEL)) {
            return new Response(Intervention.CARRY_ON, null);
        }
        if (said.equalsIgnoreCase(END_LABEL)) {
            return new Response(Intervention.END,
                    "The person watching this run ended it here. What the harness saw: "
                            + strike.evidence());
        }
        return new Response(Intervention.CHANGE_COURSE,
                whatHappened(strike) + " What the harness saw: " + strike.evidence()
                        + " They said: \"" + said + "\"." + remedy(strike));
    }

    /**
     * What actually happened to the call, per detector — and it differs, which
     * is why one shared sentence was a defect rather than a wording choice.
     * Detector 1 fires BEFORE the call and the call is dropped; detector 2 fires
     * after the result is already in the history, so nothing was stopped and
     * saying otherwise contradicts the transcript the model can see; detector 3
     * fires between turns, where there is no call at all.
     *
     * @param strike what fired
     * @return the sentence stating the situation
     */
    private static String whatHappened(Strike strike) {
        return switch (strike.detector()) {
            case IDENTICAL_WRITES -> "The person watching this run stopped that write:"
                    + " it did not run.";
            case REPEATED_FAILURE -> "That call already ran and failed " + strike.count()
                    + " times in a row with byte-identical input — its result is in the"
                    + " history above, and nothing was stopped.";
            case STALLED_PLAN -> "The person watching this run stepped in between turns:"
                    + " no call was stopped, and the plan has not moved.";
        };
    }

    /**
     * What to do instead, per detector, for the same reason.
     *
     * @param strike what fired
     * @return the closing sentence handed to the model
     */
    private static String remedy(Strike strike) {
        return switch (strike.detector()) {
            case IDENTICAL_WRITES -> " Do something different: writing the same bytes"
                    + " under another name is not a different action.";
            case REPEATED_FAILURE -> " Do something different: that call fails the same"
                    + " way every time it is run unchanged. Change the assertion or change"
                    + " the implementation.";
            case STALLED_PLAN -> " Do something different: move a step of the plan, or"
                    + " replace the plan with one you can move.";
        };
    }

    /** Drops one detector's memory after the operator steered the run.
     *  @param detector the net that fired */
    private void forget(Detector detector) {
        switch (detector) {
            case IDENTICAL_WRITES -> {
                pathsByContent.clear();
                sizeByContent.clear();
            }
            case REPEATED_FAILURE -> failuresInARow.clear();
            case STALLED_PLAN -> {
                planSignature = null;
                planUnchangedTurns = 0;
            }
        }
    }

    /** The question as a person reads it, capped so the bar stays readable.
     *  @param strike what fired
     *  @return the question text */
    private static String questionText(Strike strike) {
        String tail = " Nothing seems to be moving. Carry on, change course, or end the run?"
                + " You can also answer in your own words.";
        String evidence = strike.evidence();
        int room = MAX_QUESTION_CHARS - tail.length();
        if (evidence.length() > room) {
            evidence = evidence.substring(0, Math.max(0, room - 1)) + "…";
        }
        return evidence + tail;
    }

    /** The call as it was issued, short enough for one sentence.
     *  @param toolName the tool
     *  @param input    its input
     *  @return the command line when there is one, else the tool and its input */
    private static String callSummary(String toolName, JsonNode input) {
        if (input != null && input.path("command").isTextual()) {
            return clip(input.path("command").asText());
        }
        return toolName + " " + clip(input == null ? "{}" : input.toString());
    }

    /** Clips one fact to a length a sentence can carry.
     *  @param text the fact
     *  @return the text, or its first 120 characters with an ellipsis */
    private static String clip(String text) {
        return clip(text, 120);
    }

    /** Clips one fact to an explicit budget.
     *  @param text the fact
     *  @param max  the most characters the sentence can spend on it
     *  @return the text, or its first {@code max} characters with an ellipsis */
    private static String clip(String text, int max) {
        return text.length() <= max ? text : text.substring(0, max - 1) + "…";
    }

    /** The hash detector 1 compares on. SHA-256 because the alternative is
     *  storing every file the run ever wrote in memory to compare it byte by
     *  byte; a collision here would cost one wrong question, not a wrong write.
     *  @param content the bytes about to be written
     *  @return the hex digest */
    private static String sha256(String content) {
        try {
            return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256")
                    .digest(content.getBytes(StandardCharsets.UTF_8)));
        } catch (NoSuchAlgorithmException impossible) {
            throw new IllegalStateException("SHA-256 is required of every JVM", impossible);
        }
    }

    /** An insertion-ordered map that forgets its oldest entry past {@link #MEMORY}.
     *  @param <V> the value type
     *  @return the bounded map */
    private static <V> Map<String, V> boundedMap() {
        return new LinkedHashMap<>() {
            @Override
            protected boolean removeEldestEntry(Map.Entry<String, V> eldest) {
                return size() > MEMORY;
            }
        };
    }
}
