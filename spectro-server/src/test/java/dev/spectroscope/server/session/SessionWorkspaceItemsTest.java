package dev.spectroscope.server.session;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import dev.spectroscope.core.config.SpectroConfig;
import dev.spectroscope.core.provider.LlmProvider;
import dev.spectroscope.core.session.SessionStore;
import dev.spectroscope.server.playbooks.PlaybookFolders;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.Timeout;
import org.junit.jupiter.api.io.TempDir;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.concurrent.TimeUnit;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * Card 558, round 2 (integrator decisions 3, 4 and 5): the workspace source is
 * the session's own working folder, its {@code .claude} and {@code .spectro}
 * skills, commands and agents; a new folder from the chip is read again; a
 * playbook item named like a built-in chat command is always namespaced.
 */
@Timeout(value = 60, unit = TimeUnit.SECONDS, threadMode = Timeout.ThreadMode.SEPARATE_THREAD)
class SessionWorkspaceItemsTest {

    private static final ObjectMapper JSON = new ObjectMapper();

    @TempDir Path folderA;
    @TempDir Path folderB;
    @TempDir Path playbookDir;

    private final List<String> sessions = new ArrayList<>();

    @AfterEach
    void clean() throws IOException {
        for (String id : sessions) {
            if (id != null) {
                Files.deleteIfExists(SessionStore.sessionFile(id));
            }
        }
    }

    private static void write(Path root, String rel, String text) throws IOException {
        Path f = root.resolve(rel);
        Files.createDirectories(f.getParent());
        Files.writeString(f, text);
    }

    /** Folder A: a .spectro skill, a .claude command and a .claude agent; folder B: a .claude skill. */
    private void folders() throws IOException {
        write(folderA, ".spectro/skills/alpha/SKILL.md", "---\nname: alpha\ndescription: Alpha of A\n---\nalpha body");
        write(folderA, ".claude/commands/deploy.md", "---\ndescription: Deploy from A\n---\nDeploy A now.");
        write(folderA, ".claude/agents/scout.md",
                "---\nname: scout\ndescription: Scouts A\ntools: Read, Grep\n---\nYou scout folder A.");
        write(folderB, ".claude/skills/beta/SKILL.md", "---\nname: beta\ndescription: Beta of B\n---\nbeta body");
    }

    private static final class Recorder implements LlmProvider {
        final List<ProviderRequest> requests = new CopyOnWriteArrayList<>();

        @Override
        public Iterable<ProviderEvent> stream(ProviderRequest request) {
            requests.add(request);
            return List.of(new PTextDelta("ok"), new PStop(PStop.StopReason.END_TURN));
        }

        @Override
        public String modelName() {
            return "qwen3:8b";
        }
    }

    private record Session(SessionConnection connection, FakeSocket socket, Recorder provider) {
    }

    private Session session(String socketId, Path folder) {
        FakeSocket socket = new FakeSocket(socketId, "ws://localhost/ws");
        Recorder provider = new Recorder();
        SessionConnection connection = new SessionConnection(socket, JSON,
                SpectroConfig.load(new SpectroConfig.Overrides("ollama", "qwen3:8b", null, null, null,
                        folder.toString())), null);
        connection.providerBuilderForTest(c -> provider);
        connection.start();
        connection.onSetWorkspace("set", folder.toString());
        sessions.add(connection.sessionId());
        return new Session(connection, socket, provider);
    }

    private static List<JsonNode> frames(FakeSocket socket, String type) throws IOException {
        List<JsonNode> out = new ArrayList<>();
        for (FakeSocket.Frame f : socket.frames()) {
            JsonNode n = JSON.readTree(f.payload());
            if (type.equals(n.path("type").asText())) {
                out.add(n);
            }
        }
        return out;
    }

    private static long mainRunEnds(FakeSocket socket) throws IOException {
        List<String> mainRuns = frames(socket, "run_start").stream()
                .filter(n -> "main".equals(n.path("agentId").asText())).map(n -> n.path("runId").asText()).toList();
        return frames(socket, "run_end").stream().filter(n -> mainRuns.contains(n.path("runId").asText())).count();
    }

    private static void turn(Session s, String text) throws Exception {
        long before = mainRunEnds(s.socket());
        s.connection().onUserMessage(text, null);
        long until = System.nanoTime() + TimeUnit.SECONDS.toNanos(30);
        while (mainRunEnds(s.socket()) == before) {
            if (System.nanoTime() > until) {
                throw new AssertionError("the turn did not end: " + s.socket().textJoined());
            }
            Thread.sleep(20);
        }
    }

    private static LlmProvider.ProviderRequest last(Session s) {
        return s.provider().requests.getLast();
    }

    private static List<String> tools(LlmProvider.ProviderRequest request) {
        return request.tools().stream().map(LlmProvider.ToolSpec::name).toList();
    }

    private static List<String> names(JsonNode frame) {
        List<String> out = new ArrayList<>();
        frame.path("items").forEach(i -> out.add(i.path("kind").asText() + " " + i.path("name").asText() + " "
                + i.path("source").asText()));
        return out;
    }

    @Test
    void twoSessionsInTwoFoldersEachReadTheirOwnWorkspace() throws Exception {
        folders();
        Session a = session("ws-558-r2-a", folderA);
        Session b = session("ws-558-r2-b", folderB);

        turn(a, "hello");
        turn(b, "hello");

        assertThat(last(a).system()).contains("- alpha: Alpha of A").contains("- deploy: Deploy from A")
                .doesNotContain("beta");
        assertThat(tools(last(a))).contains("spawn_named_agent");
        assertThat(last(a).tools().stream().filter(t -> t.name().equals("spawn_named_agent")).findFirst()
                .orElseThrow().description()).contains("scout (explore): Scouts A");
        assertThat(last(b).system()).contains("- beta: Beta of B").doesNotContain("alpha").doesNotContain("deploy");
        assertThat(tools(last(b))).doesNotContain("spawn_named_agent");
    }

    @Test
    void aNewFolderFromTheChipIsReadAgain() throws Exception {
        folders();
        Session s = session("ws-558-r2-chip", folderA);
        s.connection().onGetSessionItems();
        assertThat(names(frames(s.socket(), "session_items").getLast()))
                .contains("skill alpha workspace", "command deploy workspace", "agent scout workspace");

        s.connection().onSetWorkspace("set", folderB.toString());

        assertThat(names(frames(s.socket(), "session_items").getLast()))
                .as("the page that asked hears the new folder's items")
                .contains("skill beta workspace").doesNotContain("skill alpha workspace");
        turn(s, "hello");
        assertThat(last(s).system()).contains("- beta: Beta of B").doesNotContain("alpha");
    }

    @Test
    void aPlaybookCommandNamedLikeABuiltInChatCommandIsAlwaysNamespaced() throws Exception {
        Files.writeString(playbookDir.resolve("playbook.json"), """
            { "schema_version": 1, "id": "team-x", "name": "Team X", "description": "d",
              "models": { "strong": { "primary": { "provider": "ollama", "model": "qwen3:8b" } } },
              "start": "write",
              "nodes": [
                { "kind": "step", "id": "write", "name": "Write", "performer": "chat", "model": "strong" },
                { "kind": "end", "id": "done", "result": "done" }
              ],
              "arrows": [ { "from": "write", "to": "done" } ],
              "contents": { "commands": ["commands/clear.md", "commands/ship.md"] } }
            """);
        write(playbookDir, "commands/clear.md", "---\ndescription: Clear the build\n---\nRemove build/ only.");
        write(playbookDir, "commands/ship.md", "---\ndescription: Ship\n---\nShip it.");
        PlaybookFolders.inHome().register(playbookDir);
        Session s = session("ws-558-r2-builtin", folderB);

        s.connection().onSetPlaybook(playbookDir.toRealPath().toString());

        assertThat(names(frames(s.socket(), "session_items").getLast()))
                .contains("command team-x:clear playbook", "command ship playbook")
                .doesNotContain("command clear playbook");
        turn(s, "/team-x:clear before the release");
        assertThat(last(s).system()).contains("- team-x:clear: Clear the build").doesNotContain("- clear:");
        StringBuilder sent = new StringBuilder();
        last(s).messages().forEach(m -> m.content().forEach(c -> {
            if (c instanceof LlmProvider.TextContent t) {
                sent.append(t.text());
            }
        }));
        assertThat(sent.toString()).contains("Remove build/ only.");
    }

    /** Round 3, decision 1: a workspace command named like a built-in stays reachable under workspace:. */
    @Test
    void aWorkspaceCommandNamedLikeABuiltInIsNamespaced() throws Exception {
        write(folderA, ".claude/commands/clear.md", "---\ndescription: Clear the cache\n---\nRemove .cache only.");
        Session s = session("ws-558-r3-clear", folderA);

        s.connection().onGetSessionItems();

        assertThat(names(frames(s.socket(), "session_items").getLast()))
                .contains("command workspace:clear workspace").doesNotContain("command clear workspace");
    }

    /**
     * Owner answer of 2026-10-13: a command only the terminal runs reserves no
     * word, so a workspace command named like it keeps its plain name, while a
     * web command's word still forces the namespace.
     */
    @Test
    void aWorkspaceCommandNamedLikeATerminalOnlyCommandKeepsItsPlainName() throws Exception {
        write(folderA, ".claude/commands/model.md", "---\ndescription: Pick the model\n---\nUse the strong one.");
        write(folderA, ".claude/commands/loop.md", "---\ndescription: Loop it\n---\nAgain.");
        Session s = session("ws-558-owner-model", folderA);

        s.connection().onGetSessionItems();

        assertThat(names(frames(s.socket(), "session_items").getLast()))
                .contains("command model workspace", "command workspace:loop workspace")
                .doesNotContain("command workspace:model workspace", "command loop workspace");
    }

    /**
     * Round 3, decision 2: the page asks a woken stored session for its items
     * on the wake, with or without a pick; the answer is the woken folder's.
     */
    @Test
    void aWokenSessionWithoutAPickAnswersWithItsOwnFolder() throws Exception {
        folders();
        String id = "20261012-233000-w558wake";
        Files.createDirectories(SessionStore.SESSIONS_DIR);
        Files.writeString(SessionStore.sessionFile(id),
                "{\"type\":\"run_start\",\"runId\":\"r1\",\"agentId\":\"main\",\"prompt\":\"A\",\"workspace\":"
                        + JSON.writeValueAsString(folderA.toString()) + ",\"ts\":1}\n"
                        + "{\"type\":\"run_end\",\"runId\":\"r1\",\"stopReason\":\"end_turn\",\"ts\":2}\n");
        sessions.add(id);
        FakeSocket socket = new FakeSocket("ws-558-r3-wake", "ws://localhost/ws");
        SessionConnection connection = new SessionConnection(socket, JSON,
                SpectroConfig.load(new SpectroConfig.Overrides("ollama", "qwen3:8b", null, null, null,
                        folderB.toString())), null);
        connection.start();

        connection.onWakeSession(id);
        connection.onGetSessionItems();

        JsonNode items = frames(socket, "session_items").getLast();
        assertThat(items.path("playbook").isNull()).isTrue();
        assertThat(names(items)).contains("skill alpha workspace").doesNotContain("skill beta workspace");
    }

    /** A minimal playbook with the given id and contents. */
    private static String playbookJson(String id, String contents) {
        return """
            { "schema_version": 1, "id": "%s", "name": "Team X", "description": "d",
              "models": { "strong": { "primary": { "provider": "ollama", "model": "qwen3:8b" } } },
              "start": "write",
              "nodes": [
                { "kind": "step", "id": "write", "name": "Write", "performer": "chat", "model": "strong" },
                { "kind": "end", "id": "done", "result": "done" }
              ],
              "arrows": [ { "from": "write", "to": "done" } ],
              "contents": %s }
            """.formatted(id, contents);
    }

    /** Review finding 1: a session whose folder is the home reads the user's skills once. */
    @Test
    void aSessionInTheHomeFolderReadsTheUsersSkillsOnce() throws Exception {
        Path home = Path.of(System.getProperty("user.home"));
        Path skill = home.resolve(".spectro/skills/homeskill-558");
        write(home, ".spectro/skills/homeskill-558/SKILL.md", "---\nname: homeskill-558\n---\nhome body");
        try {
            Session s = session("ws-558-r4-home", home);
            s.connection().onGetSessionItems();

            List<String> rows = names(frames(s.socket(), "session_items").getLast());
            assertThat(rows.stream().filter(r -> r.contains("homeskill-558")).toList())
                    .containsExactly("skill homeskill-558 user");
        } finally {
            Files.deleteIfExists(skill.resolve("SKILL.md"));
            Files.deleteIfExists(skill);
        }
    }

    /** Review finding 2: a skill and a command with one name in one source both stay. */
    @Test
    void aSkillAndACommandWithOneNameInOneSourceBothStay() throws Exception {
        write(folderA, ".claude/skills/review/SKILL.md", "---\nname: review\ndescription: Review skill\n---\nskill body");
        write(folderA, ".claude/commands/review.md", "---\ndescription: Review command\n---\ncommand body");
        Files.writeString(playbookDir.resolve("playbook.json"), playbookJson("team-x",
                "{ \"skills\": [\"skills/powers\"], \"commands\": [\"commands/ship.md\"] }"));
        write(playbookDir, "skills/powers/ship/SKILL.md", "---\nname: ship\ndescription: Ship skill\n---\nship body");
        write(playbookDir, "commands/ship.md", "---\ndescription: Ship command\n---\nShip it.");
        PlaybookFolders.inHome().register(playbookDir);
        Session s = session("ws-558-r4-pair", folderA);

        s.connection().onSetPlaybook(playbookDir.toRealPath().toString());

        assertThat(names(frames(s.socket(), "session_items").getLast())).contains(
                "skill review workspace", "command workspace:review workspace",
                "skill ship playbook", "command team-x:ship playbook");
    }

    /** Review finding 4: an id that is not a valid playbook id becomes no namespace, and the session hears why. */
    @Test
    void aPlaybookWithAnInvalidIdGivesNoItemsAndTheSessionHearsWhy() throws Exception {
        Files.writeString(playbookDir.resolve("playbook.json"), playbookJson("user:a",
                "{ \"commands\": [\"commands/ship.md\"] }"));
        write(playbookDir, "commands/ship.md", "---\ndescription: Ship\n---\nShip it.");
        PlaybookFolders.inHome().register(playbookDir);
        Session s = session("ws-558-r4-badid", folderB);

        s.connection().onSetPlaybook(playbookDir.toRealPath().toString());

        JsonNode items = frames(s.socket(), "session_items").getLast();
        assertThat(items.path("playbook").isNull()).isTrue();
        assertThat(names(items)).noneMatch(r -> r.contains("ship"));
        assertThat(frames(s.socket(), "error").stream().map(e -> e.path("message").asText()).toList())
                .anySatisfy(m -> assertThat(m).contains("user:a").contains("not a valid playbook id"));
    }
}
