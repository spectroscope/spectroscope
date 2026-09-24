package dev.spectroscope.core.tools;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import dev.spectroscope.core.CancelSignal;
import dev.spectroscope.core.config.SpectroConfig;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.Timeout;
import org.junit.jupiter.api.io.TempDir;

import java.nio.file.Path;
import java.util.Map;
import java.util.concurrent.TimeUnit;
import java.util.function.Function;
import java.util.stream.Collectors;

import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * Card 359, criterion 1: the shell tool's model-facing sentence has to move
 * with the budget it announces.
 *
 * <p>{@code run_command}'s {@code description()} typed its ten as a literal,
 * one line under a method whose own parameter javadoc says "tests shrink it".
 * The sentence was therefore already untrue in every test that did — the
 * canon's "a claim that reaches further than the code", living in its third
 * house after the code and the test.</p>
 *
 * <p>The assertions compare TWO budgets rather than looking for a digit. Card
 * 359 says why in one line: a test that only asserts "10" appears is green on
 * the literal it exists to kill. The chain that makes the number reachable
 * (record component, writer key, probe, doc row) is pinned next door in
 * {@code ShellAndDockKeysTest}, which lives in the config package because the
 * writer's key list is package-private there.</p>
 */
@Timeout(value = 20, unit = TimeUnit.SECONDS)
class CommandTimeoutSettingTest {

    private static final ObjectMapper JSON = new ObjectMapper();

    private static Map<String, Tool> tools(long commandTimeoutSeconds) {
        return StandardTools.all(commandTimeoutSeconds).stream()
                .collect(Collectors.toMap(Tool::name, Function.identity()));
    }

    private static String descriptionAt(long seconds) {
        return tools(seconds).get("run_command").description();
    }

    @Test
    void theDescriptionMovesWithTheBudgetItAnnounces() {
        // Two budgets, and the sentence handed to the model has to differ.
        // assertNotEquals is the half that cannot pass on a literal.
        String atThree = descriptionAt(3);
        String atTen = descriptionAt(10);
        assertNotEquals(atTen, atThree,
                "run_command tells the model the same timeout whichever budget it was"
                        + " built with — the number in the description is a literal, and"
                        + " every test that shrinks the budget is handed a lie");
        assertTrue(atThree.contains("3 s timeout"),
                "a tool built with a three-second budget does not announce three seconds: "
                        + atThree);
        assertFalse(atThree.contains("10 s timeout"),
                "a tool built with a three-second budget still announces ten: " + atThree);
        assertTrue(atTen.contains("10 s timeout"),
                "a tool built with a ten-second budget does not announce ten: " + atTen);
    }

    @Test
    void theShippedBeltAnnouncesTheNumberTheRecordShips() {
        // Card 370 replaced the test that stood here, which could not fail.
        // It compared descriptionAt(DEFAULT_COMMAND_TIMEOUT_SECONDS) with the
        // description off StandardTools.all(), and all() returns
        // all(COMMAND_TIMEOUT_SECONDS) while COMMAND_TIMEOUT_SECONDS IS
        // DEFAULT_COMMAND_TIMEOUT_SECONDS. Both sides were one expression, and
        // its own comment named the three belts nobody parameterised and then
        // asserted a tautology about them.
        //
        // What stands here instead is the shipped number itself, plus the
        // assertion that the sentence moves, so the literal above cannot be
        // satisfied by a literal below.
        String shipped = descriptionAt(SpectroConfig.DEFAULT_COMMAND_TIMEOUT_SECONDS);
        assertTrue(shipped.contains("900 s timeout"), shipped);
        assertNotEquals(shipped, descriptionAt(SpectroConfig.DEFAULT_COMMAND_TIMEOUT_SECONDS + 1),
                "the description moves with the number, so the assertion above is not a literal match");
    }

    @Test
    void theTimeoutErrorQuotesTheActiveBudgetAndNotALiteral(@TempDir Path dir) {
        // Criterion 2's second half. The error text already derives its number;
        // pinning it is what stops a later edit re-introducing a literal beside
        // the one this card removes.
        ObjectNode input = JSON.createObjectNode().put("command", "sleep 5");
        String message = tools(1).get("run_command")
                .execute(input, new Tool.ToolContext(dir, new CancelSignal()));
        assertTrue(message.contains("timed out after 1 s"),
                "the timeout error does not quote the budget the call actually ran under: "
                        + message);
    }
}
