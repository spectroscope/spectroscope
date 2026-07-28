package dev.spectroscope.core.local;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import dev.spectroscope.core.Agent;
import dev.spectroscope.core.AgentOptions;
import dev.spectroscope.core.CancelSignal;
import dev.spectroscope.core.RunOptions;
import dev.spectroscope.core.EventStream;
import dev.spectroscope.core.provider.LlmProvider;
import dev.spectroscope.core.provider.SwitchableProvider;
import dev.spectroscope.core.tools.Tool;
import dev.spectroscope.core.tools.ToolRegistry;
import org.junit.jupiter.api.Test;

import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * Which model's capabilities the loop looks up after a MID-SESSION switch into
 * the built-in provider.
 *
 * <p>{@code run_start} already learned this lesson (card 87): it asks the live
 * {@link SwitchableProvider} for its name and only falls back to the build-time
 * label. The tool-advertisement lookup one screen further down still reads the
 * build-time label alone, so a session that booted on a cloud provider and
 * switched to the built-in reasoner keeps being told "native tools" — the exact
 * claim the catalogue exists to make per-model.</p>
 */
class CapabilityAfterProviderSwitchTest {

    private static final ObjectMapper JSON = new ObjectMapper();

    /** A provider that records the tools it was asked to advertise and answers
     *  as the LOCAL reasoner — the state after a switch to built-in. */
    private static final class LocalReasoner implements LlmProvider {
        final List<Integer> advertised = new ArrayList<>();

        @Override
        public Iterable<ProviderEvent> stream(ProviderRequest request) {
            advertised.add(request.tools().size());
            return List.of(new PTextDelta("ok"), new PStop(PStop.StopReason.END_TURN));
        }

        @Override
        public String modelName() {
            return "vibethinker-3b"; // nativeTools:false in the catalogue
        }

        @Override
        public String providerName() {
            return "spectro-local"; // the LIVE truth after the switch
        }
    }

    private static final class NoopTool implements Tool {
        public String name() {
            return "read_file";
        }

        public String description() {
            return "reads";
        }

        public JsonNode inputSchema() {
            return JSON.createObjectNode();
        }

        public boolean needsPermission() {
            return false;
        }

        public String execute(JsonNode input, Tool.ToolContext context) {
            return "";
        }
    }

    @Test
    void aSwitchIntoTheBuiltInReasonerStopsAdvertisingTools() {
        // Precondition this test rests on: the catalogue says this model cannot
        // call tools. That is the fact the loop is supposed to honour.
        assertTrue(!LocalCatalog.bundled().resolve("vibethinker-3b").profile().nativeTools(),
                "the catalogue entry under test must be the no-tools one");

        LocalReasoner live = new LocalReasoner();
        // The session booted on a cloud provider — that is the label baked into
        // AgentOptions when the agent was built — and the picker then switched it.
        SwitchableProvider switchable = new SwitchableProvider(live, "spectro-local");
        ToolRegistry registry = new ToolRegistry();
        registry.register(new NoopTool());

        List<dev.spectroscope.core.events.RunEvent> events = new ArrayList<>();
        try (EventStream stream = new Agent(AgentOptions.builder()
                .provider(switchable)
                .systemPrompt("test")
                .registry(registry)
                .cwd(Path.of("."))
                .providerName("anthropic")   // build-time label, stale after the switch
                .onPermission(request -> true)
                .build()).run("hi", new RunOptions(new CancelSignal(), null))) {
            stream.forEach(events::add);
        }

        assertEquals(List.of(0), live.advertised,
                "a model the catalogue says cannot call tools must not be offered any, "
                        + "no matter which provider the session booted on");
    }
}
