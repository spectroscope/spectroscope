package dev.spectroscope.cli;

import com.fasterxml.jackson.databind.ObjectMapper;
import dev.spectroscope.core.config.SpectroConfig;
import dev.spectroscope.core.provider.LlmProvider;
import dev.spectroscope.core.session.SessionStore;

import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;

/**
 * The child half of {@link NodeProcessProofTest}: a REAL second JVM running
 * the node command's execute path — the main path minus the config-built
 * provider (a scripted one answers with this process's PID, so the parent
 * can prove the boundary). Epoch = wall-clock at start, exactly like the
 * command's own default.
 */
final class NodeProofChild {

    private NodeProofChild() {
    }

    public static void main(String[] args) throws Exception {
        int hubPort = Integer.parseInt(args[0]);
        String contextId = args[1];
        String nodeId = args[2];

        LlmProvider scripted = request -> List.of(
                new LlmProvider.PTextDelta("pid:" + ProcessHandle.current().pid()),
                new LlmProvider.PUsage(5, 2),
                new LlmProvider.PStop(LlmProvider.PStop.StopReason.END_TURN));
        SpectroConfig config = new SpectroConfig(
                "anthropic", "claude-opus-4-8", "http://localhost:11434", 100_000, "ask",
                List.of(), "gemini", true, List.of(), 2, true,
                List.of(), null, "info", null, null, null);

        Path cwd = Files.createTempDirectory("spectro-node-proof");
        int exit = NodeCommand.execute(new ObjectMapper(), config, scripted,
                new NodeCommand.NodeSpec("127.0.0.1", hubPort, nodeId,
                        NodeCommand.freshEpoch(), contextId, "worker",
                        "report your pid", cwd, false, null),
                new SessionStore(), line -> { });
        System.exit(exit);
    }
}
