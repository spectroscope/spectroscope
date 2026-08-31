package dev.spectroscope.core.tools;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import dev.spectroscope.core.CancelSignal;
import dev.spectroscope.core.Asker;
import dev.spectroscope.core.events.RunEvent;
import org.junit.jupiter.api.Test;

import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;
import java.util.concurrent.atomic.AtomicLong;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * The ask caps are settings, not constants (card 356).
 *
 * WHY THIS IS A COMPLETION, NOT A REDESIGN. Card 265 built this tool and its
 * criterion 4 asked for "a per-run question budget whose DEFAULT is stated on
 * this card". What shipped is {@code public static final int QUESTIONS_PER_RUN
 * = 3} — a compile-time constant with no way to reach it. The same card's open
 * calls, point 2, said the quiet part out loud: "O3 — the caps (question
 * length, option count, per-run budget) are stated GUESSES on the concept and
 * want a word." The owner was owed that word, was never asked, and hit the wall
 * himself on 2026-08-31.
 *
 * THE HARD HALF IS NOT THE COUNTER. Making {@code spendOneQuestion} read a
 * field is four lines. The literals the MODEL reads are the work: the schema is
 * a {@code static final JsonNode} parsed from a text block that types "max 500
 * characters", "One to four choices" and "max 100 characters", and
 * {@code description()} types "up to four options". Raise the option cap to six
 * and every one of those sentences becomes a lie told to the thing whose
 * behaviour they exist to shape — the canon's "a claim that reaches further
 * than the code", in the one place where the reader is a language model that
 * cannot check.
 *
 * So the bites here are on DERIVATION, never on presence: a test that asserts
 * "the schema mentions 4" passes on the literal it is meant to kill. Each one
 * builds a tool with a NON-default cap and demands the model-facing text move.
 */
class AskCapsTest {

    private static final ObjectMapper JSON = new ObjectMapper();

    private static JsonNode question(String text, String... labels) {
        var options = JSON.createArrayNode();
        for (String label : labels) {
            options.add(JSON.createObjectNode().put("label", label).put("description", "why " + label));
        }
        var entry = JSON.createObjectNode()
                .put("question", text).put("header", "Storage").put("multiSelect", false);
        entry.set("options", options);
        var call = JSON.createObjectNode();
        call.set("questions", JSON.createArrayNode().add(entry));
        return call;
    }

    private record Rec(Tool.ToolContext context, List<RunEvent> events) {
        static Rec fresh(CancelSignal signal) {
            List<RunEvent> events = new ArrayList<>();
            AtomicLong wait = new AtomicLong();
            return new Rec(new Tool.ToolContext(Path.of("."), signal, "main", "call-1",
                    events::add, a -> { }, c -> { }, wait::addAndGet), events);
        }
    }

    private static AskUserQuestionTool answering(int budget, int options, int chars) {
        return new AskUserQuestionTool(q -> new Asker.Answer(List.of("Postgres")),
                budget, options, chars);
    }

    // ---- the budget is read, not remembered ------------------------------------------

    @Test
    void aBudgetOfFiveLetsTheFifthThroughAndRefusesTheSixth() {
        AskUserQuestionTool tool = answering(5, 4, 500);
        CancelSignal run = new CancelSignal();
        for (int n = 1; n <= 5; n++) {
            assertFalse(tool.execute(question("Which store? " + n, "Postgres"),
                            Rec.fresh(run).context()).startsWith("ERROR:"),
                    "question " + n + " is inside a budget of five");
        }
        assertTrue(tool.execute(question("And again?", "Postgres"), Rec.fresh(run).context())
                .startsWith("ERROR:"), "the sixth is outside it");
    }

    @Test
    void aBudgetOfOneRefusesTheSecond() {
        // The other direction, because a tool that ignored the setting and kept
        // its own 3 would pass the case above for four of its five questions.
        AskUserQuestionTool tool = answering(1, 4, 500);
        CancelSignal run = new CancelSignal();
        assertFalse(tool.execute(question("Only one?", "Postgres"), Rec.fresh(run).context())
                .startsWith("ERROR:"));
        assertTrue(tool.execute(question("A second?", "Postgres"), Rec.fresh(run).context())
                .startsWith("ERROR:"), "a budget of one means one");
    }

    @Test
    void aBudgetOfZeroNeverAsksAndNothingReachesTheWire() {
        // Card 265's own O4 proposed a switch that de-registers the ask entirely
        // "so the model never learns it exists". Zero is the reachable half of
        // that: the tool is present and always declines.
        Rec rec = Rec.fresh(new CancelSignal());
        String out = answering(0, 4, 500).execute(question("May I?", "Postgres"), rec.context());
        assertTrue(out.startsWith("ERROR:"), out);
        assertTrue(rec.events().isEmpty(), "a question nobody may ask was never asked");
    }

    @Test
    void theRefusalQuotesTheActiveBudgetRatherThanALiteral() {
        AskUserQuestionTool tool = answering(1, 4, 500);
        CancelSignal run = new CancelSignal();
        tool.execute(question("first", "Postgres"), Rec.fresh(run).context());
        String refused = tool.execute(question("second", "Postgres"), Rec.fresh(run).context());
        assertTrue(refused.contains("1 question"), refused);
        assertFalse(refused.contains("3 "), "the shipped default must not survive in the text: " + refused);
    }

    // ---- the caps the MODEL reads move with the setting -------------------------------

    @Test
    void theOptionCapIsEnforcedAndAnnouncedByTheSameNumber() {
        // Enforcement and announcement together: a tool that refused a third
        // option while its schema still offered "One to four choices" would be
        // correct and unusable, because the model only ever reads the schema.
        AskUserQuestionTool tool = answering(3, 2, 500);
        String refused = tool.execute(question("Three?", "a", "b", "c"), Rec.fresh(new CancelSignal()).context());
        assertTrue(refused.startsWith("ERROR:") && refused.contains("2"), refused);

        String modelFacing = (tool.inputSchema().toString() + " " + tool.description())
                .toLowerCase(Locale.ROOT);
        assertFalse(modelFacing.contains("one to four"),
                "the schema still types the shipped cap: " + modelFacing);
        assertFalse(modelFacing.contains("up to four options"),
                "the description still types the shipped cap: " + modelFacing);
    }

    @Test
    void theQuestionLengthCapIsEnforcedAndAnnouncedByTheSameNumber() {
        AskUserQuestionTool tool = answering(3, 4, 40);
        String refused = tool.execute(question("x".repeat(41), "Postgres"),
                Rec.fresh(new CancelSignal()).context());
        assertTrue(refused.startsWith("ERROR:") && refused.contains("40"), refused);
        assertFalse(tool.inputSchema().toString().contains("max 500 characters"),
                "the schema still types the shipped 500");
    }

    // ---- and the shipped behaviour is unchanged ---------------------------------------

    @Test
    void theOneArgumentConstructorKeepsExactlyTheShippedDefaults() {
        // The compatibility seam. Different arity from the canonical constructor
        // on purpose — the canon's parallel-build rule forbids two functional
        // parameters at the same position, and this keeps the three call sites
        // (SessionConnection, SpectroCli, ContextDescriber) compiling untouched.
        AskUserQuestionTool shipped = new AskUserQuestionTool(Asker.none());
        assertEquals(3, shipped.questionsPerRun());
        assertEquals(4, shipped.maxOptions());
        assertEquals(500, shipped.maxQuestionChars());
        assertEquals(AskUserQuestionTool.QUESTIONS_PER_RUN, shipped.questionsPerRun());
        assertEquals(AskUserQuestionTool.MAX_OPTIONS, shipped.maxOptions());
        assertEquals(AskUserQuestionTool.MAX_QUESTION_CHARS, shipped.maxQuestionChars());
    }
}
