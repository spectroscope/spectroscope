package dev.spectroscope.server.session;

import com.fasterxml.jackson.databind.ObjectMapper;
import dev.spectroscope.core.codegraph.CodeGraphBackend;
import dev.spectroscope.core.codegraph.CodeGraphSetting;
import dev.spectroscope.core.codegraph.CodeGraphSkill;
import dev.spectroscope.core.config.SpectroConfig;
import dev.spectroscope.core.tools.CodeGraphTool;
import dev.spectroscope.server.codegraph.CodeGraphController;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.Timeout;
import org.junit.jupiter.api.io.TempDir;
import org.springframework.mock.web.MockHttpServletRequest;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.Optional;
import java.util.concurrent.TimeUnit;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * Card 587, fix round (I4): every reader of {@code codeGraphBackend} asks one
 * resolver for the folder at hand ({@link CodeGraphSetting}): the session's
 * {@code code_graph} tool and with it the skill offer and {@code /graph ask},
 * the build endpoints, and the System context view. A folder whose own settings
 * name a refused value is read the same way by all of them: that file costs
 * its scope, and no reader fails or answers differently.
 */
@Timeout(value = 60, unit = TimeUnit.SECONDS, threadMode = Timeout.ThreadMode.SEPARATE_THREAD)
class CodeGraphReadersTest {

    private static final ObjectMapper JSON = new ObjectMapper();
    private static final Path START = Path.of(System.getProperty("user.dir"));

    private static Path refusingFolder(Path folder) throws IOException {
        Path file = folder.resolve(SpectroConfig.PROJECT_SETTINGS);
        Files.createDirectories(file.getParent());
        Files.writeString(file, "{\"codeGraphBackend\":\"othergraph\"}");
        return folder;
    }

    @Test
    void aRefusedValueInTheFoldersOwnSettingsIsReadTheSameWayByEveryReader(@TempDir Path folder)
            throws IOException {
        refusingFolder(folder);
        CodeGraphBackend expected = CodeGraphSetting.backendFor(START, folder);

        // The session: its own tool, built on the resolver.
        FakeSocket socket = new FakeSocket("ws-587-readers", "ws://localhost/ws");
        SessionConnection connection = new SessionConnection(socket, JSON,
                SpectroConfig.load(new SpectroConfig.Overrides(null, null, null, null, null, folder.toString())), null);
        connection.start();
        connection.onSetWorkspace("set", folder.toString());
        try {
            assertThat(connection.codeGraphBackend()).as("the session").isEqualTo(expected);
            connection.onGetSessionItems();
            assertThat(socket.textJoined()).as("the session still answers with its items").contains("session_items");
        } finally {
            connection.onClose();
        }

        // The build endpoints, wired as the server wires them.
        String id = "card587-readers-" + java.util.UUID.randomUUID();
        SessionWorkspaces.resolved(id, folder.toString());
        CodeGraphController controller = new CodeGraphController(new SessionsController());
        CodeGraphController.Status status =
                (CodeGraphController.Status) controller.status(id, new MockHttpServletRequest()).getBody();
        assertThat(status).isNotNull();
        assertThat(status.backend()).as("the build endpoints").isEqualTo(expected.name());

        // The System context view, for a configuration whose workspace is that folder.
        SpectroConfig boot = SpectroConfig.load(
                new SpectroConfig.Overrides(null, null, null, null, null, folder.toString()));
        assertThat(ContextDescriber.codeGraphTool(START).backendFor(folder)).as("the System context view")
                .isEqualTo(expected);
        assertThat(ContextDescriber.describe(boot, START).systemPrompt()).as("and it still describes").isNotBlank();
    }

    /**
     * Fix round, I4 and M10: the System context view asks the backend for the
     * configured workspace and lists the app's code-graph skill while that
     * folder has a graph, as the session's own listing does.
     */
    @Test
    void theSystemContextViewAsksTheBackendOfTheWorkspaceAndListsTheBuiltInSkill(@TempDir Path base)
            throws IOException {
        CodeGraphBackend demo = new CodeGraphBackend("demograph", "demo-graph", "brew install demo-graph",
                Path.of("demo-out", "g.json"), Path.of("demo-out", "g.html"));
        Path graphed = Files.createDirectories(base.resolve("graphed/demo-out")).getParent();
        Files.writeString(graphed.resolve("demo-out/g.json"), "{}");
        Files.writeString(graphed.resolve("demo-out/g.html"), "<html></html>");
        Path bare = Files.createDirectories(base.resolve("bare"));
        List<Path> asked = new ArrayList<>();
        CodeGraphTool tool = new CodeGraphTool(folder -> {
            asked.add(folder);
            return demo;
        }, backend -> Optional.of("/opt/tools/" + backend.binary()),
                (argv, workdir, signal) -> new CodeGraphTool.Outcome("", 0, false, false, false));

        ContextInfo listed = ContextDescriber.describe(SpectroConfig.load(
                new SpectroConfig.Overrides(null, null, null, null, null, graphed.toString())), START, tool);
        assertThat(listed.skills()).extracting(ContextInfo.SkillInfo::name).contains(CodeGraphSkill.NAME);
        assertThat(listed.systemPrompt()).contains("- " + CodeGraphSkill.NAME + ": ")
                .contains(tool.systemPromptLine());
        assertThat(asked).anyMatch(folder -> folder != null && folder.endsWith("graphed"));

        ContextInfo unlisted = ContextDescriber.describe(SpectroConfig.load(
                new SpectroConfig.Overrides(null, null, null, null, null, bare.toString())), START, tool);
        assertThat(unlisted.skills()).extracting(ContextInfo.SkillInfo::name)
                .as("a folder without a graph lists no code-graph skill").doesNotContain(CodeGraphSkill.NAME);
    }
}
