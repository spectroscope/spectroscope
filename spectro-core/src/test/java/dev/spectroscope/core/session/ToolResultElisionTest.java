package dev.spectroscope.core.session;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import dev.spectroscope.core.provider.LlmProvider.ProviderContent;
import dev.spectroscope.core.provider.LlmProvider.ProviderMessage;
import dev.spectroscope.core.provider.LlmProvider.TextContent;
import dev.spectroscope.core.provider.LlmProvider.ToolCallContent;
import dev.spectroscope.core.provider.LlmProvider.ToolResultContent;
import org.junit.jupiter.api.Test;

import java.util.ArrayList;
import java.util.List;
import java.util.Set;
import java.util.function.Predicate;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotEquals;
import static org.junit.jupiter.api.Assertions.assertSame;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * Card 467: an old, large tool result leaves the outgoing request as a one-line
 * stub, while the history the agent keeps holds every byte.
 *
 * <p>Every test here builds the elision with its own numbers (keep 4 turns,
 * 1,000 chars, a batch of 8,000) so the guarantees stay pinned whatever the
 * shipped defaults become after the census. The shipped numbers carry the
 * census in their javadoc, and {@code numbers.json} carries that javadoc; the
 * census table itself lives in the card's evidence folder, outside this repo.</p>
 */
class ToolResultElisionTest {

    private static final ObjectMapper JSON = new ObjectMapper();

    private static final int KEEP = 4;
    private static final int MIN = 1_000;
    private static final int BATCH = 8_000;

    /** Every tool counts as repeatable here; what each stub says a second
     *  call does comes from the shipped tier map. */
    private static final Predicate<String> ANY = name -> true;

    private static ToolResultElision elision() {
        return new ToolResultElision(true, ANY, KEEP, MIN, BATCH);
    }

    /** A recognisable body: every line names the file, so a stub that leaked a
     *  single line of content would be caught by a plain contains. */
    private static String body(int chars) {
        StringBuilder out = new StringBuilder();
        while (out.length() < chars) {
            out.append("SECRET-LINE-OF-CLAUDE-MD\n");
        }
        return out.substring(0, chars);
    }

    private static JsonNode pathInput(String path) {
        return JSON.createObjectNode().put("path", path);
    }

    /** A conversation builder: one prompt, then rounds of (assistant call, user result). */
    private static final class Talk {
        final List<ProviderMessage> messages = new ArrayList<>();

        Talk() {
            messages.add(new ProviderMessage(ProviderMessage.Role.USER,
                    List.of(new TextContent("read the files"))));
        }

        Talk round(String callId, String tool, JsonNode input, String output) {
            messages.add(new ProviderMessage(ProviderMessage.Role.ASSISTANT,
                    List.of(new ToolCallContent(callId, tool, input))));
            messages.add(new ProviderMessage(ProviderMessage.Role.USER,
                    List.of(new ToolResultContent(callId, output, false))));
            return this;
        }

        /** A round whose result is small, so it ages the earlier ones and
         *  adds nothing elidable of its own. */
        Talk filler(int n) {
            for (int i = 0; i < n; i++) {
                round("f" + messages.size(), "list_dir", pathInput("."), "a.txt");
            }
            return this;
        }
    }

    /** The output that rides in the request for one call id. */
    private static String sent(List<ProviderMessage> request, String callId) {
        for (ProviderMessage message : request) {
            for (ProviderContent content : message.content()) {
                if (content instanceof ToolResultContent result && result.callId().equals(callId)) {
                    return result.output();
                }
            }
        }
        throw new AssertionError("no result for " + callId + " in the request");
    }

    @Test
    void aResultOlderThanTheKeptTurnsAndLargerThanTheFloorBecomesAOneLineStub() {
        String claude = body(56_000);
        Talk talk = new Talk().round("c1", "read_file", pathInput("CLAUDE.md"), claude).filler(KEEP + 1);

        List<ProviderMessage> request = elision().requestView(talk.messages);

        String stub = sent(request, "c1");
        assertNotEquals(claude, stub, "a 56,000-char result five turns back still rides in full");
        assertFalse(stub.contains("\n"), "the stub is one line: " + stub);
        assertTrue(stub.contains("read_file"), "the stub names the tool: " + stub);
        assertTrue(stub.contains("CLAUDE.md"), "the stub names the path: " + stub);
        assertTrue(stub.contains("56,000"), "the stub states the size in chars: " + stub);
        assertTrue(stub.contains("again"), "the stub says the tool can be called again: " + stub);
    }

    /** The stub one tool's old, large result gets, with the shipped tier map. */
    private static String stubFor(String tool, JsonNode input) {
        Talk talk = new Talk().round("c1", tool, input, body(56_000)).filler(KEEP + 1);
        return sent(elision().requestView(talk.messages), "c1");
    }

    @Test
    void aStubForAToolThatOnlyReadsSaysACallReadsItAsItIsNow() {
        for (String tool : List.of("read_file", "grep", "web_fetch", "browser_read_page")) {
            String stub = stubFor(tool, pathInput("x"));
            assertTrue(stub.contains("Call " + tool + " again to read it as it is now."),
                    "a read tool's stub should send the model to read again: " + stub);
            assertFalse(stub.contains("effects"), stub);
        }
    }

    @Test
    void aStubForACommandSaysACallRunsItAgainWithItsEffects() {
        String stub = stubFor("run_command", JSON.createObjectNode().put("command", "npm install"));

        assertTrue(stub.contains("for command \"npm\""), "the stub names the command's first word: " + stub);
        assertTrue(stub.contains("Calling run_command again runs it again, with its effects,"
                + " and may return a different result."), stub);
        assertFalse(stub.contains("to read it as it is now"),
                "a command's stub told the model a second call only reads: " + stub);
    }

    @Test
    void aStubForAToolNobodyRatedSaysACallRunsItAgainWithItsEffects() {
        // An MCP tool the tier map does not name resolves to eval-execute, the
        // same rule the permission gate applies.
        for (String tool : List.of("mcp__someserver__do_thing", "write_file", "browser_computer")) {
            String stub = stubFor(tool, pathInput("x"));
            assertTrue(stub.contains("Calling " + tool + " again runs it again, with its effects"),
                    tool + " was stubbed as if a second call only read: " + stub);
        }
    }

    @Test
    void aResultInsideTheKeptTurnsStays() {
        String claude = body(56_000);
        // Exactly KEEP assistant turns after it: the edge of the window, inside.
        Talk talk = new Talk().round("c1", "read_file", pathInput("CLAUDE.md"), claude).filler(KEEP);

        List<ProviderMessage> request = elision().requestView(talk.messages);

        assertEquals(claude, sent(request, "c1"),
                "a result the model read " + KEEP + " turns ago is still inside the window");
    }

    @Test
    void aSmallResultStays() {
        String small = body(MIN);
        Talk talk = new Talk();
        // Many small results, old enough, and together far above the batch:
        // none of them is large enough on its own to be stubbed.
        for (int i = 0; i < 20; i++) {
            talk.round("s" + i, "read_file", pathInput("f" + i + ".txt"), small);
        }
        talk.filler(KEEP + 1);

        List<ProviderMessage> request = elision().requestView(talk.messages);

        for (int i = 0; i < 20; i++) {
            assertEquals(small, sent(request, "s" + i), "a result of exactly " + MIN
                    + " chars is at the floor, not above it, and stays");
        }
    }

    @Test
    void theHistoryHandedInKeepsEveryByte() {
        String claude = body(56_000);
        Talk talk = new Talk().round("c1", "read_file", pathInput("CLAUDE.md"), claude).filler(KEEP + 1);
        List<ProviderMessage> before = List.copyOf(talk.messages);

        List<ProviderMessage> request = elision().requestView(talk.messages);

        assertNotEquals(claude, sent(request, "c1"), "premise: the request was elided");
        assertEquals(before, talk.messages, "the history object was rewritten");
        assertEquals(claude, sent(talk.messages, "c1"), "the history lost the full result");
    }

    @Test
    void theStubCarriesNoFileContentOnlyToolPathAndSize() {
        String claude = body(20_000);
        Talk talk = new Talk().round("c1", "read_file", pathInput("docs/CLAUDE.md"), claude).filler(KEEP + 1);

        String stub = sent(elision().requestView(talk.messages), "c1");

        assertFalse(stub.contains("SECRET-LINE"), "the stub leaked file content: " + stub);
        assertTrue(stub.contains("docs/CLAUDE.md") && stub.contains("20,000") && stub.contains("read_file"),
                "the stub must still name path, size and tool: " + stub);
    }

    @Test
    void anArgumentThatIsNotAPathOrACommandNeverReachesTheStub() {
        // write_file and edit_file carry content in their INPUT. The stub
        // whitelists path and command; anything else stays out.
        JsonNode input = JSON.createObjectNode()
                .put("path", "notes.txt").put("content", "SECRET-LINE-IN-THE-INPUT");
        Talk talk = new Talk().round("c1", "write_file", input, body(12_000)).filler(KEEP + 1);

        String stub = sent(elision().requestView(talk.messages), "c1");

        assertFalse(stub.contains("SECRET-LINE-IN-THE-INPUT"), "an input field leaked: " + stub);
        assertTrue(stub.contains("notes.txt"), "the path is still named: " + stub);
    }

    @Test
    void aShellResultIsNamedByTheFirstWordOfItsCommandOnOneLine() {
        String command = "./gradlew test --rerun-tasks\n" + "x".repeat(400);
        JsonNode input = JSON.createObjectNode().put("command", command);
        Talk talk = new Talk().round("c1", "run_command", input, body(10_000)).filler(KEEP + 1);

        String stub = sent(elision().requestView(talk.messages), "c1");

        assertTrue(stub.contains("for command \"./gradlew\""), "the first word is named: " + stub);
        assertFalse(stub.contains("--rerun-tasks"), "the stub repeated more than the first word: " + stub);
        assertFalse(stub.contains("\n"), "a multi-line command broke the stub's one line: " + stub);
    }

    @Test
    void aHeredocBodyNeverReachesTheStub() {
        String command = "cat > deploy.env <<'EOF'\nAPI_KEY=SECRET-IN-THE-HEREDOC\nEOF";
        JsonNode input = JSON.createObjectNode().put("command", command);
        Talk talk = new Talk().round("c1", "run_command", input, body(10_000)).filler(KEEP + 1);

        String stub = sent(elision().requestView(talk.messages), "c1");

        assertTrue(stub.contains("for command \"cat\""), "the first word is named: " + stub);
        assertFalse(stub.contains("SECRET-IN-THE-HEREDOC"), "the heredoc body leaked: " + stub);
        assertFalse(stub.contains("deploy.env"), "the command's arguments leaked: " + stub);
    }

    @Test
    void aLeadingVariableAssignmentIsNotTheFirstWord() {
        String command = "TOKEN=SECRET-IN-AN-ASSIGNMENT LANG=C curl https://example.com";
        JsonNode input = JSON.createObjectNode().put("command", command);
        Talk talk = new Talk().round("c1", "run_command", input, body(10_000)).filler(KEEP + 1);

        String stub = sent(elision().requestView(talk.messages), "c1");

        assertTrue(stub.contains("for command \"curl\""), "the command word is named: " + stub);
        assertFalse(stub.contains("SECRET-IN-AN-ASSIGNMENT"), "an assignment leaked: " + stub);
    }

    @Test
    void theArgumentIsAtMostFortyChars() {
        String path = "docs/" + "very-long-directory-name/".repeat(8) + "file.md";
        String word = "x".repeat(100);
        for (JsonNode input : List.of(pathInput(path),
                JSON.createObjectNode().put("command", word + " --flag"))) {
            Talk talk = new Talk().round("c1", "run_command", input, body(10_000)).filler(KEEP + 1);

            String stub = sent(elision().requestView(talk.messages), "c1");

            int open = stub.indexOf(" \"") + 2;
            String argument = stub.substring(open, stub.indexOf('"', open));
            // The card's cap is 40 chars; a cut argument ends in "...".
            assertTrue(argument.length() <= 40 + 3,
                    "the argument runs " + argument.length() + " chars: " + stub);
            assertTrue(argument.length() >= 40, "premise: the argument was long enough to cut: " + stub);
        }
    }

    @Test
    void nothingChangesUntilTheElidableAmountReachesABatch() {
        // One old result of 5,000 chars saves less than a batch on its own.
        Talk talk = new Talk().round("c1", "read_file", pathInput("a.md"), body(5_000)).filler(KEEP + 1);
        ToolResultElision elision = elision();

        List<ProviderMessage> first = elision.requestView(talk.messages);
        assertEquals(body(5_000), sent(first, "c1"), "below one batch, the request must stay as it was");

        // A second old result pushes the pending saving over the batch.
        talk.round("c2", "read_file", pathInput("b.md"), body(5_000)).filler(KEEP + 1);
        List<ProviderMessage> second = elision.requestView(talk.messages);
        assertNotEquals(body(5_000), sent(second, "c1"), "the batch fired and left c1 out");
        assertNotEquals(body(5_000), sent(second, "c2"), "the batch fired and left c2 out");
    }

    @Test
    void twoConsecutiveRequestsWithNoNewElidableResultSendIdenticalHistory() {
        Talk talk = new Talk().round("c1", "read_file", pathInput("CLAUDE.md"), body(56_000)).filler(KEEP + 1);
        ToolResultElision elision = elision();
        List<ProviderMessage> first = elision.requestView(talk.messages);
        assertNotEquals(body(56_000), sent(first, "c1"), "premise: the first batch fired");

        // A new round whose result is old enough nowhere and large nowhere.
        talk.filler(1);
        List<ProviderMessage> second = elision.requestView(talk.messages);

        assertEquals(first, second.subList(0, first.size()),
                "the prefix the first request sent must reach the second one unchanged, or an"
                        + " Anthropic cached prefix dies on a request that elided nothing new");
    }

    @Test
    void aResultTheBatchHasNotReachedYetDoesNotMoveTheCachedPrefix() {
        Talk talk = new Talk().round("c1", "read_file", pathInput("CLAUDE.md"), body(56_000)).filler(KEEP + 1);
        ToolResultElision elision = elision();
        List<ProviderMessage> first = elision.requestView(talk.messages);

        // A 3,000-char result ages past K: elidable, but under a batch.
        talk.round("c2", "read_file", pathInput("small.md"), body(3_000)).filler(KEEP + 1);
        List<ProviderMessage> second = elision.requestView(talk.messages);

        assertEquals(first, second.subList(0, first.size()), "the old prefix moved");
        assertEquals(body(3_000), sent(second, "c2"), "a sub-batch saving changed the request");
    }

    @Test
    void offSendsTheHistoryUntouched() {
        Talk talk = new Talk().round("c1", "read_file", pathInput("CLAUDE.md"), body(56_000)).filler(KEEP + 1);

        List<ProviderMessage> request =
                new ToolResultElision(false, ANY, KEEP, MIN, BATCH).requestView(talk.messages);

        assertSame(talk.messages, request, "off must hand the history through as it is");
    }

    @Test
    void aToolWhoseResultCannotBeFetchedAgainIsNeverStubbed() {
        Set<String> once = Set.of("spawn_agent");
        Talk talk = new Talk()
                .round("c1", "spawn_agent", JSON.createObjectNode().put("task", "survey"), body(30_000))
                .filler(KEEP + 1);

        List<ProviderMessage> request = new ToolResultElision(true, name -> !once.contains(name),
                KEEP, MIN, BATCH).requestView(talk.messages);

        assertEquals(body(30_000), sent(request, "c1"),
                "a child's report cannot be had again by calling the tool, so the stub would lie");
    }

    @Test
    void aReplacedHistoryStartsTheBookkeepingAgain() {
        ToolResultElision elision = elision();
        Talk long_ = new Talk().round("c1", "read_file", pathInput("CLAUDE.md"), body(56_000)).filler(KEEP + 1);
        elision.requestView(long_.messages);

        // Compaction replaces the history with a summary plus the last messages.
        // A fresh result now sits at the position c1 held, under the same id.
        Talk fresh = new Talk().round("c1", "read_file", pathInput("CLAUDE.md"), body(56_000));
        List<ProviderMessage> request = elision.requestView(fresh.messages);

        assertEquals(body(56_000), sent(request, "c1"),
                "a result the model has just read was stubbed because an older one stood there");
    }

    @Test
    void aPlaceThatNowHoldsAnotherCallIsForgotten() {
        ToolResultElision elision = elision();
        Talk before = new Talk().round("c1", "read_file", pathInput("CLAUDE.md"), body(56_000)).filler(KEEP + 1);
        elision.requestView(before.messages);

        // A replaced history of the same shape: the place c1 held now holds
        // another call, whose result is small and must stay whole.
        Talk after = new Talk().round("d1", "read_file", pathInput("note.md"), body(500)).filler(KEEP + 1);
        List<ProviderMessage> request = elision.requestView(after.messages);

        assertEquals(body(500), sent(request, "d1"),
                "a stub remembered for c1 landed on d1, a result small enough to stay");
    }
}
