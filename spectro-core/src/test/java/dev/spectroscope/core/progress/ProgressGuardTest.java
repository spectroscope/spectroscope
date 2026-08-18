package dev.spectroscope.core.progress;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import dev.spectroscope.core.Asker;
import dev.spectroscope.core.CancelSignal;
import dev.spectroscope.core.events.RunEvent;
import dev.spectroscope.core.progress.ProgressGuard.Detector;
import dev.spectroscope.core.progress.ProgressGuard.Intervention;
import dev.spectroscope.core.progress.ProgressGuard.Response;
import dev.spectroscope.core.progress.ProgressGuard.Strike;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.Timeout;

import java.util.ArrayList;
import java.util.List;
import java.util.Optional;
import java.util.concurrent.TimeUnit;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertInstanceOf;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertSame;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * The three detectors and the one verdict (card 262).
 *
 * <p>Two halves, and the second is the one that decides whether this ships:
 * the detectors have to catch the measured loop, and they have to stay SILENT
 * on honest work. A guard that cannot be shown to stay quiet is not finished —
 * it is a switch operators will turn off.</p>
 */
@Timeout(value = 30, unit = TimeUnit.SECONDS)
class ProgressGuardTest {

    private static final ObjectMapper JSON = new ObjectMapper();

    private static ProgressGuard guard() {
        return new ProgressGuard(ProgressSettings.defaults(), Asker.none());
    }

    // ---- criterion 1: the owner's directory, replayed as a sequence ----------

    @Test
    void theFixtureCarriesTheSizeTheOwnerMeasured() {
        // The guard's own sentence quotes this number. A fixture that drifted off
        // 283 would make the sentence a fiction while every other test stayed green.
        assertEquals(283, ParticleLoopFixture.engineBytes(),
                "the fixture's one distinct content must be the 283 bytes measured in"
                        + " ~/particle_Stephan_deepseek on 2026-08-17");
        assertEquals(31, ParticleLoopFixture.COPIES);
    }

    @Test
    void theMeasuredLoopIsCaughtAtTheFOURTHCopyAndNotBefore() {
        ProgressGuard guard = guard();
        List<ParticleLoopFixture.Call> calls = ParticleLoopFixture.replay(ParticleLoopFixture.COPIES);

        Strike first = null;
        int callsBefore = 0;
        for (ParticleLoopFixture.Call call : calls) {
            Optional<Strike> onCall = guard.observeCall(call.tool(), call.input());
            if (onCall.isPresent()) {
                first = onCall.get();
                break;
            }
            Optional<Strike> onResult =
                    guard.observeResult(call.tool(), call.input(), call.failed());
            if (onResult.isPresent()) {
                first = onResult.get();
                break;
            }
            callsBefore++;
        }

        assertNotNull(first, "the guard watched 31 identical copies and said nothing");
        assertEquals(Detector.IDENTICAL_WRITES, first.detector(),
                "detector 1 is the one that catches this loop: the model VARIED the"
                        + " command every round (particleEngine31.test.js), so the repeated"
                        + " failure counter never accumulates here");
        assertEquals(3, first.count(),
                "three earlier paths already carry those bytes when the fourth starts");
        // Nine calls make three full rounds (engine, test, command); the tenth is
        // the fourth engine write, and that is the one that must speak.
        assertEquals(9, callsBefore,
                "the scenario says the transcript speaks when the FOURTH copy starts —"
                        + " earlier is a guard that cannot tell a second copy from a loop,"
                        + " later is an hour of a paid model");
        assertTrue(first.evidence().contains("283 bytes"),
                "the sentence names what it saw; was: " + first.evidence());
        assertTrue(first.evidence().contains("src/particleEngine4.js"),
                "the sentence names the copy that was starting; was: " + first.evidence());
    }

    // ---- criterion 2, detector 1 --------------------------------------------

    @Test
    void rewritingTheSAMEPathIsNotANewPath() {
        // The whole detector is "under a NEW name". A model that saves the same
        // file ten times over is doing something else, and this must not fire.
        ProgressGuard guard = guard();
        String body = "x".repeat(200);
        for (int i = 0; i < 10; i++) {
            assertTrue(guard.observeCall("write_file",
                            ParticleLoopFixture.write("src/a.js", body)).isEmpty(),
                    "the same path rewritten is not a copy, round " + i);
        }
    }

    @Test
    void aPathAlreadySEENIsNotANewCopyEvenWhenTheCountIsFull() {
        // The version of the rule that a set alone does NOT give you, and the one
        // a first pass at this test missed: once three distinct paths carry those
        // bytes, saving one of THEM again is still not a fourth copy. Without the
        // explicit check the detector fires on a plain re-save, which is the most
        // ordinary thing an editor does.
        ProgressGuard guard = guard();
        String body = "y".repeat(200);
        for (String path : List.of("src/a.js", "src/b.js", "src/c.js")) {
            assertTrue(guard.observeCall("write_file",
                    ParticleLoopFixture.write(path, body)).isEmpty(), path);
        }
        assertTrue(guard.observeCall("write_file",
                        ParticleLoopFixture.write("src/b.js", body)).isEmpty(),
                "re-saving a path the run already wrote is not a copy under a new name");
        assertTrue(guard.observeCall("write_file",
                        ParticleLoopFixture.write("src/d.js", body)).isPresent(),
                "and a genuinely new path still fires — the rule narrowed, it did not vanish");
    }

    @Test
    void theFloorKeepsAScaffoldsEmptyFilesOutOfIt() {
        // A scaffold writes empty __init__.py by the dozen. Byte-identical, and
        // entirely honest. This is why the detector has a floor at all.
        ProgressGuard guard = guard();
        for (int i = 0; i < 12; i++) {
            assertTrue(guard.observeCall("write_file",
                            ParticleLoopFixture.write("pkg/mod" + i + "/__init__.py", "")).isEmpty(),
                    "an empty file is not evidence of a loop, file " + i);
        }
    }

    // ---- criterion 5: the guard cannot fire on honest work -------------------

    @Test
    void aScaffoldWritingManySimilarFilesStaysSilent() {
        // Twenty components, each a full file, each differing only where a
        // scaffold's files differ — by its own name. Similar is not identical,
        // and the detector hashes the content rather than eyeballing it.
        ProgressGuard guard = guard();
        for (int i = 1; i <= 20; i++) {
            String name = "Widget" + i;
            String body = """
                    import { html } from "../runtime.js";

                    export class %s extends HTMLElement {
                      connectedCallback() {
                        this.replaceChildren(html`<div class="%s"></div>`);
                      }
                    }
                    customElements.define("x-%s", %s);
                    """.formatted(name, name.toLowerCase(java.util.Locale.ROOT),
                    name.toLowerCase(java.util.Locale.ROOT), name);
            assertTrue(guard.observeCall("write_file",
                            ParticleLoopFixture.write("src/" + name + ".js", body)).isEmpty(),
                    "a scaffold is honest work; it fired on component " + i);
            assertTrue(guard.observeResult("write_file",
                            ParticleLoopFixture.write("src/" + name + ".js", body), false).isEmpty(),
                    "a successful write is not a failure, component " + i);
        }
    }

    @Test
    void aFlakyTestThatFailsTwiceAndThenPassesStaysSilent() {
        // The other half of criterion 5, and the reason the threshold sits above
        // two AND the counter resets on success rather than only decaying.
        ProgressGuard guard = guard();
        JsonNode input = JSON.createObjectNode().put("command", "npm test -- --grep race");
        assertTrue(guard.observeResult("run_command", input, true).isEmpty(), "first failure");
        assertTrue(guard.observeResult("run_command", input, true).isEmpty(), "second failure");
        assertTrue(guard.observeResult("run_command", input, false).isEmpty(), "then it passed");
        // And the count really is back at zero, not merely below the line: two
        // more failures after the pass must still be quiet.
        assertTrue(guard.observeResult("run_command", input, true).isEmpty(),
                "a pass RESETS the counter — one failure after it is one, not three");
        assertTrue(guard.observeResult("run_command", input, true).isEmpty(),
                "two failures after the pass is two");
    }

    @Test
    void theSameCallFailingThreeTimesInARowFires() {
        ProgressGuard guard = guard();
        JsonNode input = JSON.createObjectNode().put("command", "node --test test/a.test.js");
        assertTrue(guard.observeResult("run_command", input, true).isEmpty());
        assertTrue(guard.observeResult("run_command", input, true).isEmpty());
        Strike strike = guard.observeResult("run_command", input, true)
                .orElseThrow(() -> new AssertionError("three failures in a row said nothing"));
        assertEquals(Detector.REPEATED_FAILURE, strike.detector());
        assertEquals(3, strike.count());
        assertTrue(strike.evidence().contains("node --test test/a.test.js"),
                "the sentence names the call it saw; was: " + strike.evidence());
    }

    @Test
    void aVariedInputNeverAccumulates() {
        // "unchanged input" is the detector's own words. A model working through
        // twelve different failing tests is not looping.
        ProgressGuard guard = guard();
        for (int i = 1; i <= 12; i++) {
            JsonNode input = JSON.createObjectNode().put("command", "node --test test/t" + i + ".js");
            assertTrue(guard.observeResult("run_command", input, true).isEmpty(),
                    "different input, different work — fired at " + i);
        }
    }

    // ---- criterion 2, detector 3 --------------------------------------------

    @Test
    void theStalledPlanNetIsOffUnlessItIsTurnedOn() {
        // Its default is 0 and that is a decision, stated on the card: it needs a
        // plan that exists and is maintained, and the runs this guard was cut for
        // keep none.
        assertEquals(0, ProgressSettings.defaults().stalledPlanTurns());
        ProgressGuard guard = guard();
        RunEvent.Plan plan = plan("write the engine", "in_progress");
        for (int turn = 0; turn < 20; turn++) {
            assertTrue(guard.observeTurn(plan).isEmpty(), "off means off, turn " + turn);
        }
    }

    @Test
    void aPlanThatHasNotMovedForNTurnsFiresWhenArmed() {
        ProgressGuard guard = new ProgressGuard(new ProgressSettings(0, 0, 3), Asker.none());
        RunEvent.Plan plan = plan("write the engine", "in_progress");
        assertTrue(guard.observeTurn(plan).isEmpty(), "turn 1 establishes the plan");
        assertTrue(guard.observeTurn(plan).isEmpty(), "turn 2 is one unmoved turn");
        assertTrue(guard.observeTurn(plan).isEmpty(), "turn 3 is two");
        Strike strike = guard.observeTurn(plan)
                .orElseThrow(() -> new AssertionError("three unmoved turns said nothing"));
        assertEquals(Detector.STALLED_PLAN, strike.detector());
        assertEquals(3, strike.count());
    }

    @Test
    void aPlanThatMOVESResetsTheCount() {
        ProgressGuard guard = new ProgressGuard(new ProgressSettings(0, 0, 3), Asker.none());
        RunEvent.Plan open = plan("write the engine", "in_progress");
        assertTrue(guard.observeTurn(open).isEmpty());
        assertTrue(guard.observeTurn(open).isEmpty());
        assertTrue(guard.observeTurn(plan("write the engine", "completed",
                "make the test pass", "in_progress")).isEmpty(), "the plan moved");
        RunEvent.Plan moved = plan("write the engine", "completed",
                "make the test pass", "in_progress");
        assertTrue(guard.observeTurn(moved).isEmpty(), "one unmoved turn after the move");
        assertTrue(guard.observeTurn(moved).isEmpty(), "two");
    }

    @Test
    void aRunWithNoPlanAtAllIsNeverGradedByThePlanNet() {
        // The precondition the card demands be STATED rather than assumed: a weak
        // local model keeps no plan, and that is exactly the run this guard is
        // for — so this net is silent there by construction and must never be the
        // only thing standing.
        ProgressGuard guard = new ProgressGuard(new ProgressSettings(0, 0, 2), Asker.none());
        for (int turn = 0; turn < 20; turn++) {
            assertTrue(guard.observeTurn(null).isEmpty(), "no plan, no verdict, turn " + turn);
        }
    }

    @Test
    void aFINISHEDPlanThatStopsMovingIsNotAStall() {
        // A run whose steps are all completed and which then spends two turns
        // writing its summary has not stalled. Only OPEN steps can stall.
        ProgressGuard guard = new ProgressGuard(new ProgressSettings(0, 0, 2), Asker.none());
        RunEvent.Plan done = plan("write the engine", "completed");
        for (int turn = 0; turn < 10; turn++) {
            assertTrue(guard.observeTurn(done).isEmpty(), "all steps done, turn " + turn);
        }
    }

    // ---- criterion 6: the numbers ------------------------------------------

    @Test
    void zeroTurnsADetectorOff() {
        ProgressGuard guard = new ProgressGuard(ProgressSettings.off(), Asker.none());
        for (int i = 1; i <= 10; i++) {
            assertTrue(guard.observeCall("write_file",
                    ParticleLoopFixture.write("src/c" + i + ".js", ParticleLoopFixture.ENGINE))
                    .isEmpty(), "identical writes are off, copy " + i);
            assertTrue(guard.observeResult("run_command",
                    JSON.createObjectNode().put("command", "false"), true).isEmpty(),
                    "repeated failures are off, round " + i);
        }
        assertFalse(ProgressSettings.off().armed());
        assertTrue(ProgressSettings.defaults().armed());
    }

    @Test
    void theThresholdIsTheNumberItFiresOn() {
        ProgressGuard two = new ProgressGuard(new ProgressSettings(2, 0, 0), Asker.none());
        assertTrue(two.observeCall("write_file",
                ParticleLoopFixture.write("a.js", ParticleLoopFixture.ENGINE)).isEmpty());
        assertTrue(two.observeCall("write_file",
                ParticleLoopFixture.write("b.js", ParticleLoopFixture.ENGINE)).isEmpty());
        assertEquals(2, two.observeCall("write_file",
                        ParticleLoopFixture.write("c.js", ParticleLoopFixture.ENGINE))
                .orElseThrow(() -> new AssertionError("a threshold of 2 must fire on the third"))
                .count());
    }

    // ---- criterion 3 + 4: it says so, and then it asks -----------------------

    @Test
    void itSaysWhatItSawBEFOREItAsksAnything() {
        List<RunEvent> events = new ArrayList<>();
        ProgressGuard guard = new ProgressGuard(ProgressSettings.defaults(),
                question -> {
                    // The transcript line must already be out when the person is
                    // asked: a run cancelled while the question is parked still
                    // has to carry the observation.
                    assertEquals(2, events.size(),
                            "by the time a person is parked on, exactly the observation and"
                                    + " the question have gone out");
                    assertInstanceOf(RunEvent.NoProgress.class, events.get(0),
                            "no_progress FIRST: a run cancelled while the question is parked"
                                    + " still has to carry the observation");
                    assertInstanceOf(RunEvent.QuestionAsked.class, events.get(1));
                    return new Asker.Answer(List.of(ProgressGuard.CARRY_ON_LABEL));
                });
        Strike strike = new Strike(Detector.IDENTICAL_WRITES, 3, "the same 283 bytes, 3 times");
        Response response = guard.intervene(strike, "main", events::add, new CancelSignal());

        assertEquals(Intervention.CARRY_ON, response.intervention());
        RunEvent.NoProgress said = (RunEvent.NoProgress) events.get(0);
        assertEquals("identical_writes", said.detector(),
                "pin on the enum's wire name, never on the prose beside it");
        assertEquals(3, said.count());
        assertEquals("main", said.agentId());
        assertTrue(events.stream().anyMatch(RunEvent.QuestionAsked.class::isInstance),
                "warn AND PAUSE — the owner's decision was not warn alone");
        assertTrue(events.stream().anyMatch(RunEvent.QuestionAnswered.class::isInstance),
                "the answer is on the record too, or the pause is invisible afterwards");
    }

    @Test
    void theThreeAnswersMapToTheThreeOutcomes() {
        assertEquals(Intervention.CARRY_ON, answered(ProgressGuard.CARRY_ON_LABEL).intervention());
        assertEquals(Intervention.CHANGE_COURSE,
                answered(ProgressGuard.CHANGE_COURSE_LABEL).intervention());
        assertEquals(Intervention.END, answered(ProgressGuard.END_LABEL).intervention());
    }

    @Test
    void wordsOfTheirOwnAreGuidanceAndReachTheModelVerbatim() {
        // Card 265 lets a person answer in their own words. Anything that is not
        // one of the three labels is steering, and steering that the model never
        // reads is the same as no answer at all.
        Response response = answered("delete src/ and start over with a plan");
        assertEquals(Intervention.CHANGE_COURSE, response.intervention());
        assertNotNull(response.guidance(), "a change of course with nothing to say is a stop");
        assertTrue(response.guidance().contains("delete src/ and start over with a plan"),
                "the operator's own words must reach the model; was: " + response.guidance());
    }

    /**
     * Review finding F5, and a decision this branch made explicitly instead of
     * inheriting it. This test replaces {@code nobodyToAskLeavesTheRunGoingAndNeverAsksTwice},
     * whose claim was wrong rather than merely unpinned: an unanswered strike
     * used to stand the detector down, so in permission mode {@code auto} or
     * {@code readonly} — where {@code ParkingAsker} returns null before it parks
     * — the owner's "warn AND pause" degraded to "warn ONCE, for the whole run",
     * and the 31-copy loop this card was cut from would have produced a single
     * line and then silence.
     *
     * <p>The stand-down is what a PERSON's "carry on" buys, because a person
     * looked. Nobody at all buys a re-arm: the net stays up and the loop has to
     * earn a full N again before it speaks. The cost is stated rather than
     * hidden — an unattended run that really does repeat itself writes a line
     * every N events instead of one, which is a transcript that shows the loop
     * continuing instead of a transcript that mentions it once.</p>
     */
    @Test
    void nobodyToAskLeavesTheRunGoingAndLeavesTheNetUP() {
        List<RunEvent> events = new ArrayList<>();
        ProgressGuard guard = new ProgressGuard(ProgressSettings.defaults(), Asker.none());
        Strike strike = new Strike(Detector.IDENTICAL_WRITES, 3, "three copies");
        Response response = guard.intervene(strike, "main", events::add, new CancelSignal());

        assertEquals(Intervention.CARRY_ON, response.intervention(),
                "ending a run on nobody's word would be the silent abort criterion 3 forbids");
        assertTrue(events.stream().anyMatch(RunEvent.NoProgress.class::isInstance),
                "unanswered or not, the observation is on the wire");
        RunEvent.QuestionAnswered answer = events.stream()
                .filter(RunEvent.QuestionAnswered.class::isInstance)
                .map(RunEvent.QuestionAnswered.class::cast)
                .findFirst().orElseThrow(() -> new AssertionError("no question_answered"));
        assertTrue(answer.cancelled(),
                "nobody answered — recorded as cancelled, never as an invented reply");

        // The net is still up, and it costs a full N to speak again.
        for (int i = 1; i <= 3; i++) {
            assertTrue(guard.observeCall("write_file",
                            ParticleLoopFixture.write("src/e" + i + ".js", ParticleLoopFixture.ENGINE))
                            .isEmpty(),
                    "copy " + i + " of the next N is not a strike on its own");
        }
        assertTrue(guard.observeCall("write_file",
                        ParticleLoopFixture.write("src/e4.js", ParticleLoopFixture.ENGINE))
                        .isPresent(),
                "nobody said carry on, because nobody was there — an unattended run that"
                        + " keeps looping keeps saying so");
    }

    /** The other direction of the same decision: a PERSON saying carry on does
     *  buy the silence, for the rest of the run. Without this pin the one above
     *  is green for a guard that never stands anything down at all. */
    @Test
    void aPersonSayingCarryOnBuysTheSilenceNobodyAtAllCannot() {
        ProgressGuard guard = new ProgressGuard(ProgressSettings.defaults(),
                question -> new Asker.Answer(List.of(ProgressGuard.CARRY_ON_LABEL)));
        guard.intervene(new Strike(Detector.IDENTICAL_WRITES, 3, "three copies"), "main",
                event -> { }, new CancelSignal());

        for (int i = 1; i <= 12; i++) {
            assertTrue(guard.observeCall("write_file",
                            ParticleLoopFixture.write("src/p" + i + ".js", ParticleLoopFixture.ENGINE))
                            .isEmpty(),
                    "the person looked and said it is fine; copy " + i + " must stay quiet");
        }
    }

    @Test
    void aCancelledRunIsNeverParkedOn() {
        CancelSignal signal = new CancelSignal();
        signal.cancel();
        List<RunEvent> events = new ArrayList<>();
        ProgressGuard guard = new ProgressGuard(ProgressSettings.defaults(),
                question -> {
                    throw new AssertionError("a cancelled run must not reach a person");
                });
        Response response = guard.intervene(
                new Strike(Detector.IDENTICAL_WRITES, 3, "three copies"), "main",
                events::add, signal);
        assertEquals(Intervention.CARRY_ON, response.intervention());
    }

    @Test
    void anAskerThatThrowsIsAFaceThatBrokeAndNotAnAnswer() {
        List<RunEvent> events = new ArrayList<>();
        ProgressGuard guard = new ProgressGuard(ProgressSettings.defaults(),
                question -> {
                    throw new IllegalStateException("socket went away mid-question");
                });
        Response response = guard.intervene(
                new Strike(Detector.IDENTICAL_WRITES, 3, "three copies"), "main",
                events::add, new CancelSignal());
        assertEquals(Intervention.CARRY_ON, response.intervention(),
                "a broken face must not end somebody's run");
    }

    @Test
    void theQuestionOffersExactlyTheThreeChoicesTheOwnerNamed() {
        List<RunEvent.QuestionAsked> asked = new ArrayList<>();
        ProgressGuard guard = new ProgressGuard(ProgressSettings.defaults(), question -> {
            asked.add(question);
            return new Asker.Answer(List.of(ProgressGuard.END_LABEL));
        });
        guard.intervene(new Strike(Detector.REPEATED_FAILURE, 3, "the same command, 3 times"),
                "main", event -> { }, new CancelSignal());

        assertEquals(1, asked.size());
        RunEvent.AskedQuestion question = asked.get(0).questions().get(0);
        assertEquals(List.of(ProgressGuard.CARRY_ON_LABEL, ProgressGuard.CHANGE_COURSE_LABEL,
                        ProgressGuard.END_LABEL),
                question.options().stream().map(RunEvent.QuestionOption::label).toList(),
                "carry on, change course, or end it — the owner's own three");
        assertFalse(question.multiSelect(), "one decision, not a shopping list");
        assertTrue(question.question().contains("the same command, 3 times"),
                "the question carries the evidence; was: " + question.question());
    }

    @Test
    void aStrikeAnsweredWithCarryOnStandsThatDetectorDownButNotTheOthers() {
        // Two detectors are two independent judgements. Saying "carry on" about
        // the copies is not saying "carry on" about a command failing forever.
        ProgressGuard guard = new ProgressGuard(ProgressSettings.defaults(),
                question -> new Asker.Answer(List.of(ProgressGuard.CARRY_ON_LABEL)));
        guard.intervene(new Strike(Detector.IDENTICAL_WRITES, 3, "copies"), "main",
                event -> { }, new CancelSignal());

        JsonNode input = JSON.createObjectNode().put("command", "node --test test/a.test.js");
        guard.observeResult("run_command", input, true);
        guard.observeResult("run_command", input, true);
        assertTrue(guard.observeResult("run_command", input, true).isPresent(),
                "the OTHER detector is still standing");
    }

    /**
     * Review finding F4: the 64-character floor is a stated decision (card 262,
     * decision 6) and every value from 1 upward passed the whole gate — the only
     * test near it wrote empty content, which is under any floor at all. This
     * pins the boundary itself, which is the assertion that makes the decision
     * survive a later edit.
     */
    @Test
    void theFloorSitsAtSixtyFourCharactersAndTheBoundaryIsPinned() {
        // LITERALS on purpose. Written as MIN_CONTENT_CHARS - 1 and
        // MIN_CONTENT_CHARS this test moves with the constant and is green for
        // every value of it, which pins nothing at all.
        assertEquals(64, ProgressSettings.MIN_CONTENT_CHARS,
                "the floor is a stated decision, not a tuning knob");
        String justUnder = "x".repeat(63);
        ProgressGuard shy = guard();
        for (int i = 1; i <= 8; i++) {
            assertTrue(shy.observeCall("write_file",
                            ParticleLoopFixture.write("src/u" + i + ".js", justUnder)).isEmpty(),
                    "63 characters is below the floor and stays below it, copy " + i);
        }

        String atTheFloor = "y".repeat(64);
        ProgressGuard watching = guard();
        for (int i = 1; i <= 3; i++) {
            assertTrue(watching.observeCall("write_file",
                    ParticleLoopFixture.write("src/f" + i + ".js", atTheFloor)).isEmpty());
        }
        assertTrue(watching.observeCall("write_file",
                        ParticleLoopFixture.write("src/f4.js", atTheFloor)).isPresent(),
                "64 characters is the first content the detector looks at");
    }

    /**
     * Review finding F8: one CHANGE_COURSE sentence was handed to the model for
     * all three detectors, and it said "the person stopped that step" — untrue
     * for detector 2, whose call has already run and whose result is already in
     * the history, and meaningless for detector 3, where there is no step at all.
     * A guard that tells the model something false about its own transcript is
     * worse than one that says nothing.
     */
    @Test
    void eachDetectorsGuidanceSaysWhatActuallyHappenedToTheCall() {
        String writes = steered(Detector.IDENTICAL_WRITES);
        String failure = steered(Detector.REPEATED_FAILURE);
        String plan = steered(Detector.STALLED_PLAN);

        assertTrue(writes.contains("did not run"),
                "detector 1 fires BEFORE the call and the call is dropped; was: " + writes);
        assertTrue(failure.contains("already ran"),
                "detector 2 fires after the result is in the history — nothing was stopped;"
                        + " was: " + failure);
        assertFalse(failure.contains("did not run"),
                "the call did run; telling the model otherwise contradicts its own"
                        + " tool_result. Was: " + failure);
        assertTrue(plan.contains("plan"),
                "detector 3 fires between turns, where there is no call to talk about;"
                        + " was: " + plan);
        assertFalse(plan.contains("did not run"), "no call was stopped; was: " + plan);
        assertEquals(3, java.util.Set.of(writes, failure, plan).size(),
                "three different situations, three different sentences");
        for (String guidance : List.of(writes, failure, plan)) {
            assertTrue(guidance.contains("do it another way"),
                    "the operator's own words reach the model whichever net fired");
        }
    }

    /**
     * Review finding F10: the memory bound was never exercised. Eviction is
     * oldest-first and costs exactly one thing — the ability to notice a repeat
     * older than {@link ProgressGuard#MEMORY} distinct contents — and that cost
     * is only honest if somebody measured it.
     */
    @Test
    void theOldestContentIsForgottenPastTheMemoryBound() {
        ProgressGuard guard = guard();
        String ancient = "o".repeat(80);
        guard.observeCall("write_file", ParticleLoopFixture.write("src/old1.js", ancient));
        guard.observeCall("write_file", ParticleLoopFixture.write("src/old2.js", ancient));
        for (int i = 0; i < ProgressGuard.MEMORY; i++) {
            guard.observeCall("write_file",
                    ParticleLoopFixture.write("src/filler" + i + ".js", "f" + i + "-".repeat(80)));
        }

        assertTrue(guard.observeCall("write_file",
                ParticleLoopFixture.write("src/old3.js", ancient)).isEmpty());
        assertTrue(guard.observeCall("write_file",
                        ParticleLoopFixture.write("src/old4.js", ancient)).isEmpty(),
                "with the two ancient paths still remembered this would be the third copy"
                        + " and would fire — 512 distinct contents later they are gone,"
                        + " and that is the price of not growing forever");
    }

    /**
     * The other half of F10: the evidence sentence joined every remembered path
     * with no limit. Three paths is a sentence; an operator who set the threshold
     * to 60 got a paragraph on the wire. The structured facts keep every path —
     * that is what {@code details} is for.
     */
    @Test
    void theEvidenceStaysASentenceWhenTheOperatorSetsAHugeThreshold() {
        ProgressGuard guard = new ProgressGuard(new ProgressSettings(60, 0, 0), Asker.none());
        String content = "z".repeat(80);
        for (int i = 1; i <= 60; i++) {
            assertTrue(guard.observeCall("write_file",
                    ParticleLoopFixture.write("src/aFairlyLongModuleName" + i + ".js", content))
                    .isEmpty());
        }
        Strike strike = guard.observeCall("write_file",
                        ParticleLoopFixture.write("src/aFairlyLongModuleName61.js", content))
                .orElseThrow(() -> new AssertionError("60 paths and the 61st did not fire"));

        assertTrue(strike.evidence().length() <= 400,
                "the sentence goes to a terminal and an ask bar; it was "
                        + strike.evidence().length() + " characters");
        assertEquals(61, strike.details().size(),
                "and nothing is lost — the unprosed facts carry every path");
    }

    /** One intervention per detector, steered with the same words.
     *  @param detector the net that fired
     *  @return the guidance handed to the model */
    private static String steered(Detector detector) {
        ProgressGuard guard = new ProgressGuard(ProgressSettings.defaults(),
                question -> new Asker.Answer(List.of("do it another way")));
        return guard.intervene(new Strike(detector, 3, "what the harness saw."), "main",
                event -> { }, new CancelSignal()).guidance();
    }

    /** A plan event from alternating text/status pairs.
     *  @param textAndStatus text, status, text, status …
     *  @return the plan event */
    private static RunEvent.Plan plan(String... textAndStatus) {
        List<RunEvent.PlanStep> steps = new ArrayList<>();
        for (int i = 0; i < textAndStatus.length; i += 2) {
            steps.add(new RunEvent.PlanStep(textAndStatus[i], textAndStatus[i + 1]));
        }
        return new RunEvent.Plan("main", steps, 1L);
    }

    /** Runs one intervention with a scripted answer.
     *  @param answer what the person said
     *  @return the guard's response */
    private static Response answered(String answer) {
        ProgressGuard guard = new ProgressGuard(ProgressSettings.defaults(),
                question -> new Asker.Answer(List.of(answer)));
        return guard.intervene(new Strike(Detector.IDENTICAL_WRITES, 3, "three copies"),
                "main", event -> { }, new CancelSignal());
    }
}
