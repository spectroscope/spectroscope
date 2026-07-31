package dev.spectroscope.samples.otel;

import com.fasterxml.jackson.databind.ObjectMapper;
import dev.spectroscope.core.provider.LlmProvider;

import java.util.List;

/**
 * A deliberately tiny offline {@link LlmProvider} with one trick: its first
 * turn calls the real {@code write_file} tool, its second turn closes the
 * run. The agent loop executes the tool for real, so the exported trace has
 * genuine structure — an agent span, two turn generations, a tool span —
 * without a key, a server, or a model. Only the "model" is scripted; the
 * export is the shipped one.
 *
 * <p>Copied into each sample that needs it, on purpose: every sample stays
 * self-contained.</p>
 */
final class ScriptedProvider implements LlmProvider {

    private static final ObjectMapper JSON = new ObjectMapper();

    private int calls = 0;

    @Override
    public Iterable<ProviderEvent> stream(ProviderRequest request) {
        if (calls++ == 0) {
            return List.of(
                    new PTextDelta("Writing the greeting first."),
                    new PToolCall("call-1", "write_file", JSON.createObjectNode()
                            .put("path", "hello.txt")
                            .put("content", "hello from a scripted run\n")),
                    new PUsage(42, 17),
                    new PStop(PStop.StopReason.TOOL_USE));
        }
        return List.of(
                new PTextDelta("Done — hello.txt is in the workspace."),
                new PUsage(58, 12),
                new PStop(PStop.StopReason.END_TURN));
    }

    @Override
    public String modelName() {
        return "scripted";
    }

    @Override
    public String providerName() {
        return "scripted";
    }
}
