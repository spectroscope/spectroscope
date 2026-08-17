package dev.spectroscope.core.tools;

import com.fasterxml.jackson.databind.ObjectMapper;
import dev.spectroscope.core.Asker;
import dev.spectroscope.core.CancelSignal;
import dev.spectroscope.core.provider.LlmProvider;
import dev.spectroscope.core.subagents.SubagentConfig;
import dev.spectroscope.core.subagents.SubagentManager;
import org.junit.jupiter.api.Test;

import java.nio.file.Path;
import java.util.List;

import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * Card 265, criterion 3: <b>registration is the fence, not a runtime check.</b>
 *
 * <p>Where nobody can answer, the model must never see the tool in
 * {@code specs()} at all — not see it and be refused. A model that knows a verb
 * exists plans around it: it announces that it will ask, it phrases its answer
 * as waiting, and on a cron run at 3 a.m. that is a whole turn spent on a
 * capability the face does not have. The same fence {@code update_plan} already
 * uses.</p>
 *
 * <p>The structural half is here, in the core: nothing that a headless run, a
 * library lane or a subagent assembles its belt from may carry the tool. The
 * two faces that DO carry it are pinned where they build their belts —
 * {@code SessionAskTest} drives the server's real {@code buildAgentOnce}, and
 * {@code SpectroCliAskerTest} the CLI's own assembly.</p>
 */
class AskRegistrationFenceTest {

    private static final String ASK = "ask_user_question";

    private static boolean carriesTheAsk(List<Tool> tools) {
        return tools.stream().anyMatch(tool -> ASK.equals(tool.name()));
    }

    @Test
    void theStandardBeltNeverCarriesIt() {
        // The whole headless fence rests on this one fact: HeadlessRunner builds
        // its registry from StandardTools.all() plus MCP and nothing else, so a
        // `spectro run`, a cron fire and a triggered node cannot acquire the tool
        // without this list acquiring it first.
        assertFalse(carriesTheAsk(StandardTools.all()),
                "ask_user_question in the standard belt would put it on every headless face");
    }

    @Test
    void aSubagentsBeltNeverCarriesIt() {
        // Same rule already written for update_plan: a child must not clobber a
        // surface that belongs to the one agent the operator is watching. Worse
        // here — a subagent's question would park the CHILD's loop behind a bar
        // the parent's run does not own.
        SubagentManager subagents = new SubagentManager(SubagentConfig.builder()
                .provider(new SilentProvider())
                .cwd(Path.of("."))
                .parentAgentId("main")
                .onPermission(request -> false)
                .baseTools(List.copyOf(StandardTools.all()))
                .build());
        ToolRegistry childBelt = new ToolRegistry();
        StandardTools.all().forEach(childBelt::register);
        subagents.tools().forEach(childBelt::register);
        subagents.devTools().forEach(childBelt::register);

        assertFalse(childBelt.specs().stream().anyMatch(spec -> ASK.equals(spec.name())),
                "a subagent must not be able to ask the operator anything");
    }

    @Test
    void aToolBuiltWithNobodyAttachedNeitherHangsNorAnswers() {
        // The belt-and-braces behind the fence. A caller that builds the tool
        // anyway — the stateless context description does exactly that — must
        // get a refusal to answer rather than a parked thread. The @Timeout on
        // the module's tests is the "does not hang" half.
        ObjectMapper json = new ObjectMapper();
        var call = json.createObjectNode();
        call.set("questions", json.createArrayNode().add(json.createObjectNode()
                .put("question", "Which one?")
                .set("options", json.createArrayNode()
                        .add(json.createObjectNode().put("label", "a")))));

        String out = new AskUserQuestionTool(Asker.none())
                .execute(call, new Tool.ToolContext(Path.of("."), new CancelSignal()));
        assertTrue(out.startsWith("unanswered:"), out);
    }

    /** A provider that is never streamed — the SubagentManager only needs one to exist. */
    private static final class SilentProvider implements LlmProvider {
        @Override public String modelName() {
            return "never-called";
        }

        @Override public Iterable<ProviderEvent> stream(ProviderRequest request) {
            throw new IllegalStateException("this test never runs a child");
        }
    }
}
