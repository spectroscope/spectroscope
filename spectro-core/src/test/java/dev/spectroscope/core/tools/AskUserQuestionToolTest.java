package dev.spectroscope.core.tools;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import dev.spectroscope.core.Asker;
import dev.spectroscope.core.CancelSignal;
import dev.spectroscope.core.events.RunEvent;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.Timeout;

import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicLong;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * Card 265: {@code ask_user_question} — the one tool whose whole job is to stop
 * and wait for a person.
 *
 * <p>Two properties are load-bearing and neither is obvious. <b>An unanswered
 * question is not an error</b>: an {@code ERROR:} prefix sets {@code isError},
 * which reads to the model as a tool that failed and invites a retry, and a
 * question nobody heard is not a failure. And <b>no path ever invents an
 * answer</b> — every release lands as a {@code question_answered} with
 * {@code cancelled} true and an empty answer list.</p>
 */
@Timeout(value = 30, unit = TimeUnit.SECONDS)
class AskUserQuestionToolTest {

    private static final ObjectMapper JSON = new ObjectMapper();

    /** One well-formed call in the importer's own shape. */
    private static JsonNode oneQuestion(String question, String... labels) {
        var options = JSON.createArrayNode();
        for (String label : labels) {
            options.add(JSON.createObjectNode().put("label", label).put("description", "why " + label));
        }
        var entry = JSON.createObjectNode()
                .put("question", question)
                .put("header", "Storage")
                .put("multiSelect", false);
        entry.set("options", options);
        var call = JSON.createObjectNode();
        call.set("questions", JSON.createArrayNode().add(entry));
        return call;
    }

    /** A context that records the events the tool emits and the wait it reports.
     *  @param context      the context handed to execute
     *  @param events       everything the tool published through the emit sink
     *  @param reportedWait the millis the tool told the loop it stood parked */
    private record Recording(Tool.ToolContext context, List<RunEvent> events, AtomicLong reportedWait) {
        static Recording fresh(CancelSignal signal) {
            List<RunEvent> events = new ArrayList<>();
            AtomicLong wait = new AtomicLong();
            return new Recording(new Tool.ToolContext(Path.of("."), signal, "main", "call-1",
                    events::add, attachment -> { }, wait::addAndGet), events, wait);
        }
    }

    private static <T extends RunEvent> T only(List<RunEvent> events, Class<T> type) {
        List<RunEvent> hits = events.stream().filter(type::isInstance).toList();
        assertEquals(1, hits.size(), "exactly one " + type.getSimpleName() + ", got: " + events);
        return type.cast(hits.get(0));
    }

    @Test
    void anAnswerComesBackInTheImportersOwnProseSoTheCardReadsIt() {
        // The result wording is not decoration: toolViews.answersFor locates an
        // answer by "<question>"=" and the existing renderer marks the chosen
        // option off it. A terser sentence would leave a native question drawn
        // as one nobody ever answered.
        Recording rec = Recording.fresh(new CancelSignal());
        Asker asker = question -> new Asker.Answer(List.of("Postgres"));
        String out = new AskUserQuestionTool(asker)
                .execute(oneQuestion("Which store?", "Postgres", "SQLite"), rec.context());

        assertFalse(out.startsWith("ERROR:"), out);
        assertTrue(out.contains("\"Which store?\"=\"Postgres\""), out);
    }

    @Test
    void theQuestionAndTheAnswerBothLandOnTheWire() {
        Recording rec = Recording.fresh(new CancelSignal());
        new AskUserQuestionTool(question -> new Asker.Answer(List.of("SQLite")))
                .execute(oneQuestion("Which store?", "Postgres", "SQLite"), rec.context());

        RunEvent.QuestionAsked asked = only(rec.events(), RunEvent.QuestionAsked.class);
        assertEquals("call-1", asked.callId());
        assertEquals(1, asked.questions().size());
        assertEquals("Which store?", asked.questions().get(0).question());
        assertEquals("Storage", asked.questions().get(0).header());
        assertEquals(List.of("Postgres", "SQLite"),
                asked.questions().get(0).options().stream()
                        .map(RunEvent.QuestionOption::label).toList());

        RunEvent.QuestionAnswered answered = only(rec.events(), RunEvent.QuestionAnswered.class);
        assertEquals("call-1", answered.callId());
        assertEquals(List.of("SQLite"), answered.answers());
        assertFalse(answered.cancelled());
    }

    @Test
    void theQuestionIsOnTheWireBeforeTheToolParks() {
        // The browser must hold the question while the run is still parked on it,
        // or the bar appears after the answer it was meant to collect.
        List<String> order = new ArrayList<>();
        Tool.ToolContext context = new Tool.ToolContext(Path.of("."), new CancelSignal(), "main",
                "call-1", event -> order.add(event.getClass().getSimpleName()),
                attachment -> { }, millis -> { });
        new AskUserQuestionTool(question -> {
            order.add("parked");
            return new Asker.Answer(List.of("Postgres"));
        }).execute(oneQuestion("Which store?", "Postgres"), context);

        assertEquals(List.of("QuestionAsked", "parked", "QuestionAnswered"), order);
    }

    @Test
    void nobodyToAskIsUnansweredAndNeverAnError() {
        Recording rec = Recording.fresh(new CancelSignal());
        String out = new AskUserQuestionTool(Asker.none())
                .execute(oneQuestion("Which store?", "Postgres"), rec.context());

        assertFalse(out.startsWith("ERROR:"),
                "an ERROR prefix sets isError and invites a retry; nobody heard is not a failure");
        assertTrue(out.startsWith("unanswered:"), out);
        RunEvent.QuestionAnswered answered = only(rec.events(), RunEvent.QuestionAnswered.class);
        assertTrue(answered.cancelled());
        assertTrue(answered.answers().isEmpty(), "no release path may invent an answer");
    }

    @Test
    void aCancelledRunIsReleasedWithoutAnAnswer() {
        CancelSignal cancelled = new CancelSignal();
        cancelled.cancel();
        Recording rec = Recording.fresh(cancelled);
        // The asker that would answer is never even reached: a run already
        // cancelled must not park, and must not collect an answer either.
        String out = new AskUserQuestionTool(question -> new Asker.Answer(List.of("Postgres")))
                .execute(oneQuestion("Which store?", "Postgres"), rec.context());

        assertTrue(out.startsWith("unanswered:"), out);
        assertTrue(only(rec.events(), RunEvent.QuestionAnswered.class).cancelled());
    }

    @Test
    void theHumansWaitIsReportedToTheLoopAndRidesTheAnswer() {
        // Card 111's split, one surface further. Measured through the loop's own
        // sink rather than the wall clock of this test.
        Recording rec = Recording.fresh(new CancelSignal());
        new AskUserQuestionTool(question -> {
            sleep(120);
            return new Asker.Answer(List.of("Postgres"));
        }).execute(oneQuestion("Which store?", "Postgres"), rec.context());

        assertTrue(rec.reportedWait().get() >= 100L,
                "the parked millis are reported to the loop so they leave durationMs, was "
                        + rec.reportedWait().get());
        Long waitMs = only(rec.events(), RunEvent.QuestionAnswered.class).waitMs();
        assertTrue(waitMs != null && waitMs >= 100L, "waitMs on the answer, was " + waitMs);
    }

    @Test
    void theBoundsAreRefusedAndNeverTruncated() {
        AskUserQuestionTool tool = new AskUserQuestionTool(
                question -> new Asker.Answer(List.of("Postgres")));
        CancelSignal signal = new CancelSignal();

        var twoQuestions = JSON.createObjectNode();
        twoQuestions.set("questions", JSON.createArrayNode()
                .add(oneQuestion("a", "x").path("questions").get(0).deepCopy())
                .add(oneQuestion("b", "y").path("questions").get(0).deepCopy()));
        String two = tool.execute(twoQuestions, Recording.fresh(signal).context());
        assertTrue(two.startsWith("ERROR:") && two.contains("one question"), two);

        String longQuestion = tool.execute(oneQuestion("x".repeat(501), "Postgres"),
                Recording.fresh(signal).context());
        assertTrue(longQuestion.startsWith("ERROR:") && longQuestion.contains("500"), longQuestion);

        String tooMany = tool.execute(oneQuestion("Which store?", "a", "b", "c", "d", "e"),
                Recording.fresh(signal).context());
        assertTrue(tooMany.startsWith("ERROR:") && tooMany.contains("4"), tooMany);

        String longLabel = tool.execute(oneQuestion("Which store?", "x".repeat(101)),
                Recording.fresh(signal).context());
        assertTrue(longLabel.startsWith("ERROR:") && longLabel.contains("100"), longLabel);

        assertTrue(tool.execute(oneQuestion("   ", "Postgres"), Recording.fresh(signal).context())
                .startsWith("ERROR:"));

        assertTrue(tool.execute(oneQuestion("Which store?"), Recording.fresh(signal).context())
                        .startsWith("ERROR:"),
                "a question with nothing to pick is a chat message, and the card renderer"
                        + " cannot draw one");
    }

    @Test
    void aRefusedCallAsksNobodyAndWritesNothing() {
        Recording rec = Recording.fresh(new CancelSignal());
        new AskUserQuestionTool(question -> {
            throw new AssertionError("a malformed call must never reach a person");
        }).execute(JSON.createObjectNode(), rec.context());
        assertTrue(rec.events().isEmpty(), "nothing about a refused call belongs on the wire");
    }

    @Test
    void theFourthQuestionOfOneRunIsRefused() {
        // A model that discovers it can stall a run by asking must not be able
        // to loop. Refused as an ERROR on purpose: this one IS the tool saying no.
        AskUserQuestionTool tool = new AskUserQuestionTool(
                question -> new Asker.Answer(List.of("Postgres")));
        CancelSignal run = new CancelSignal();
        for (int n = 1; n <= AskUserQuestionTool.QUESTIONS_PER_RUN; n++) {
            assertFalse(tool.execute(oneQuestion("Which store? " + n, "Postgres"),
                            Recording.fresh(run).context()).startsWith("ERROR:"),
                    "question " + n + " is inside the budget");
        }
        Recording overBudget = Recording.fresh(run);
        String refused = tool.execute(oneQuestion("And again?", "Postgres"), overBudget.context());
        assertTrue(refused.startsWith("ERROR:") && refused.contains("budget"), refused);
        assertTrue(overBudget.events().isEmpty(),
                "a refused question was never asked, so nothing about it is on the wire");

        // A NEW run gets its own budget — the signal is the run's own lifetime.
        assertFalse(tool.execute(oneQuestion("A fresh run?", "Postgres"),
                Recording.fresh(new CancelSignal()).context()).startsWith("ERROR:"));
    }

    @Test
    void itIsPermissionFreeAndAdvertisesItselfHonestly() {
        Tool tool = new AskUserQuestionTool(Asker.none());
        assertEquals("ask_user_question", tool.name());
        assertFalse(tool.needsPermission(),
                "gating a question would be two prompts for one interaction, and a question"
                        + " has no side effect");
        String manual = tool.description().toLowerCase(java.util.Locale.ROOT);
        assertTrue(manual.contains("assumption"),
                "the description is the only instruction the model has: it must say that an"
                        + " unanswered question is survivable");
        assertTrue(manual.contains("credential"),
                "an answer lands in the transcript, so the manual has to say this is never"
                        + " the way to ask for one");
        assertEquals("array",
                tool.inputSchema().path("properties").path("questions").path("type").asText());
    }

    private static void sleep(long millis) {
        try {
            Thread.sleep(millis);
        } catch (InterruptedException interrupted) {
            Thread.currentThread().interrupt();
        }
    }
}
