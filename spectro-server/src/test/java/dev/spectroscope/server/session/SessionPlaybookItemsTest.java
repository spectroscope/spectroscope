package dev.spectroscope.server.session;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import dev.spectroscope.core.config.SpectroConfig;
import dev.spectroscope.core.playbook.ContentHash;
import dev.spectroscope.core.playbook.SafeWalk;
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
import java.util.Arrays;
import java.util.Comparator;
import java.util.List;
import java.util.Queue;
import java.util.concurrent.ConcurrentLinkedQueue;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.concurrent.TimeUnit;
import java.util.stream.Stream;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * Card 558, criteria 1 to 5 on a real {@link SessionConnection}: the playbook
 * picked for a session gives that session its skills, commands and agents,
 * read from the playbook folder in place, from the next turn on and also in a
 * plain chat without a run. A doubled name stays in every source under the
 * source's namespace. Withdrawing or changing the pick takes the items out at
 * the next turn; another session never sees them; nothing is copied and
 * nothing is written under the playbook folder.
 */
@Timeout(value = 60, unit = TimeUnit.SECONDS, threadMode = Timeout.ThreadMode.SEPARATE_THREAD)
class SessionPlaybookItemsTest {

    private static final ObjectMapper JSON = new ObjectMapper();

    private static final String PLAYBOOK = """
        { "schema_version": 1, "id": "team-x", "name": "Team X", "description": "d",
          "models": { "strong": { "primary": { "provider": "ollama", "model": "qwen3:8b" } } },
          "start": "write",
          "nodes": [
            { "kind": "step", "id": "write", "name": "Write", "performer": "chat", "model": "strong" },
            { "kind": "end", "id": "done", "result": "done" }
          ],
          "arrows": [ { "from": "write", "to": "done" } ],
          "contents": { "skills": ["skills/powers"], "commands": ["commands/ship.md"],
                        "agents": ["agents/reviewer.md"] } }
        """;

    private static final String OTHER = """
        { "schema_version": 1, "id": "team-y", "name": "Team Y", "description": "d",
          "models": { "strong": { "primary": { "provider": "ollama", "model": "qwen3:8b" } } },
          "start": "write",
          "nodes": [
            { "kind": "step", "id": "write", "name": "Write", "performer": "chat", "model": "strong" },
            { "kind": "end", "id": "done", "result": "done" }
          ],
          "arrows": [ { "from": "write", "to": "done" } ],
          "contents": { "commands": ["commands/deploy.md"] } }
        """;

    private static final String SHIP_BODY = "Ship it with care: run the gates first.";
    private static final String PREAMBLE = "You are the reviewer. Name every finding.";

    @TempDir Path workspace;
    @TempDir Path playbookDir;
    @TempDir Path otherDir;

    private final List<String> sessions = new ArrayList<>();
    private final Path userSkills = Path.of(System.getProperty("user.home"), ".spectro", "skills");
    private final Path userBrainstorming = userSkills.resolve("brainstorming");

    @AfterEach
    void clean() throws IOException {
        for (String id : sessions) {
            if (id != null) {
                Files.deleteIfExists(SessionStore.sessionFile(id));
            }
        }
        delete(userBrainstorming);
    }

    private static void delete(Path dir) throws IOException {
        if (Files.exists(dir)) {
            try (Stream<Path> walk = Files.walk(dir)) {
                for (Path p : walk.sorted(Comparator.reverseOrder()).toList()) {
                    Files.delete(p);
                }
            }
        }
    }

    /** The playbook folder: a pack of two skills (one with a file beside it), a command and an agent. */
    private Path teamX() throws IOException {
        Files.writeString(playbookDir.resolve("playbook.json"), PLAYBOOK);
        Path brainstorming = Files.createDirectories(playbookDir.resolve("skills/powers/brainstorming"));
        Files.writeString(brainstorming.resolve("SKILL.md"),
                "---\nname: brainstorming\ndescription: Team X brainstorming\n---\nAsk one question at a time.");
        Files.writeString(brainstorming.resolve("example.md"), "an example dialogue");
        Path tdd = Files.createDirectories(playbookDir.resolve("skills/powers/tdd"));
        Files.writeString(tdd.resolve("SKILL.md"), "---\nname: tdd\ndescription: Red first\n---\nWrite the test first.");
        Files.createDirectories(playbookDir.resolve("commands"));
        Files.writeString(playbookDir.resolve("commands/ship.md"),
                "---\ndescription: Ship the change\n---\n" + SHIP_BODY + "\n");
        Files.createDirectories(playbookDir.resolve("agents"));
        Files.writeString(playbookDir.resolve("agents/reviewer.md"),
                "---\nname: reviewer\ndescription: Reviews a diff\ntype: explore\n---\n" + PREAMBLE + "\n");
        PlaybookFolders.inHome().register(playbookDir);
        return playbookDir.toRealPath();
    }

    private Path teamY() throws IOException {
        Files.writeString(otherDir.resolve("playbook.json"), OTHER);
        Files.createDirectories(otherDir.resolve("commands"));
        Files.writeString(otherDir.resolve("commands/deploy.md"), "---\ndescription: Deploy\n---\nDeploy it.\n");
        PlaybookFolders.inHome().register(otherDir);
        return otherDir.toRealPath();
    }

    /** The user's own top level "brainstorming", which doubles the playbook's. */
    private void usersBrainstorming() throws IOException {
        Files.createDirectories(userBrainstorming);
        Files.writeString(userBrainstorming.resolve("SKILL.md"),
                "---\nname: brainstorming\ndescription: My own brainstorming\n---\nThink out loud.");
    }

    /** Records every request; the parent answers from a script, else "ok"; a child answers "child done". */
    private static final class Recorder implements LlmProvider {
        final List<ProviderRequest> parentRequests = new CopyOnWriteArrayList<>();
        final List<ProviderRequest> childRequests = new CopyOnWriteArrayList<>();
        final Queue<List<ProviderEvent>> parentScript = new ConcurrentLinkedQueue<>();

        @Override
        public Iterable<ProviderEvent> stream(ProviderRequest request) {
            if (request.system().contains("subagent (type")) {
                childRequests.add(request);
                return List.of(new PTextDelta("child done"), new PStop(PStop.StopReason.END_TURN));
            }
            parentRequests.add(request);
            List<ProviderEvent> scripted = parentScript.poll();
            return scripted != null ? scripted
                    : List.of(new PTextDelta("ok"), new PStop(PStop.StopReason.END_TURN));
        }

        @Override
        public String modelName() {
            return "qwen3:8b";
        }

        ProviderRequest last() {
            return parentRequests.getLast();
        }
    }

    private static List<LlmProvider.ProviderEvent> call(String name, String input) throws IOException {
        return List.of(new LlmProvider.PToolCall("c-" + name, name, JSON.readTree(input)),
                new LlmProvider.PStop(LlmProvider.PStop.StopReason.TOOL_USE));
    }

    private record Session(SessionConnection connection, FakeSocket socket, Recorder provider) {
    }

    private Session session(String socketId) {
        FakeSocket socket = new FakeSocket(socketId, "ws://localhost/ws");
        Recorder provider = new Recorder();
        SessionConnection connection = new SessionConnection(socket, JSON,
                SpectroConfig.load(new SpectroConfig.Overrides("ollama", "qwen3:8b", null, null, null,
                        workspace.toString())), null);
        connection.providerBuilderForTest(c -> provider);
        connection.start();
        connection.onSetWorkspace("set", workspace.toString());
        connection.adoptSessionConfig();
        connection.onSetPermissionMode("auto");
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

    /** Sends a prompt and waits for the main agent's run_end. */
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

    /** run_end carries no agentId: the main agent's ends are the ones whose runId a main run_start named. */
    private static long mainRunEnds(FakeSocket socket) throws IOException {
        List<String> mainRuns = frames(socket, "run_start").stream()
                .filter(n -> "main".equals(n.path("agentId").asText())).map(n -> n.path("runId").asText()).toList();
        return frames(socket, "run_end").stream().filter(n -> mainRuns.contains(n.path("runId").asText())).count();
    }

    private static List<String> tools(LlmProvider.ProviderRequest request) {
        return request.tools().stream().map(LlmProvider.ToolSpec::name).toList();
    }

    private static String userText(LlmProvider.ProviderRequest request) {
        StringBuilder out = new StringBuilder();
        for (LlmProvider.ProviderMessage m : request.messages()) {
            for (LlmProvider.ProviderContent c : m.content()) {
                if (c instanceof LlmProvider.TextContent t) {
                    out.append(t.text()).append('\n');
                }
                if (c instanceof LlmProvider.ToolResultContent r) {
                    out.append(r.output()).append('\n');
                }
            }
        }
        return out.toString();
    }

    /** Every file under a root whose bytes equal one of the playbook's files. */
    private List<Path> copiesUnder(Path root) throws IOException {
        List<byte[]> originals = new ArrayList<>();
        try (Stream<Path> walk = Files.walk(playbookDir)) {
            for (Path f : walk.filter(Files::isRegularFile).toList()) {
                originals.add(Files.readAllBytes(f));
            }
        }
        List<Path> out = new ArrayList<>();
        if (!Files.exists(root)) {
            return out;
        }
        try (Stream<Path> walk = Files.walk(root)) {
            for (Path f : walk.filter(Files::isRegularFile).toList()) {
                byte[] bytes = Files.readAllBytes(f);
                if (originals.stream().anyMatch(o -> Arrays.equals(o, bytes))) {
                    out.add(f);
                }
            }
        }
        return out;
    }

    private static String folderState(Path dir) throws IOException {
        try (Stream<Path> walk = Files.walk(dir)) {
            return walk.map(f -> dir.relativize(f).toString()).sorted().toList() + " "
                    + ContentHash.tree(SafeWalk.walk(dir, dir));
        }
    }

    @Test
    void aPickGivesThePlainChatThePlaybooksItemsAtTheNextTurnReadInPlaceAndNothingIsCopied() throws Exception {
        Path dir = teamX();
        usersBrainstorming();
        Session s = session("ws-558-pick");

        s.connection().onSetPlaybook(dir.toString());
        turn(s, "hello");

        LlmProvider.ProviderRequest request = s.provider().last();
        assertThat(request.system()).as("the playbook's skills and command are listed, the doubled name under both")
                .contains("- team-x:brainstorming: Team X brainstorming")
                .contains("- user:brainstorming: My own brainstorming")
                .contains("- tdd: Red first")
                .contains("- ship: Ship the change")
                .doesNotContain("- brainstorming:");
        assertThat(tools(request)).contains("use_skill", "read_skill_file", "spawn_named_agent");
        assertThat(request.tools().stream().filter(t -> t.name().equals("spawn_named_agent")).findFirst()
                .orElseThrow().description()).contains("reviewer (explore): Reviews a diff");
        assertThat(copiesUnder(userSkills.getParent())).as("nothing copied into ~/.spectro").isEmpty();
        assertThat(copiesUnder(workspace)).as("nothing copied into the workspace").isEmpty();
    }

    @Test
    void withoutAPickTheSessionHasNoPlaybookItemsAndTheUsersNameStaysPlain() throws Exception {
        teamX();
        usersBrainstorming();
        Session s = session("ws-558-nopick");

        turn(s, "hello");

        LlmProvider.ProviderRequest request = s.provider().last();
        assertThat(request.system()).contains("- brainstorming: My own brainstorming")
                .doesNotContain("team-x:").doesNotContain("- ship:");
        assertThat(tools(request)).doesNotContain("spawn_named_agent");
    }

    @Test
    void changingOrWithdrawingThePickTakesThePreviousItemsOutAtTheNextTurn() throws Exception {
        Path x = teamX();
        Path y = teamY();
        usersBrainstorming();
        Session s = session("ws-558-switch");
        s.connection().onSetPlaybook(x.toString());
        turn(s, "one");
        assertThat(s.provider().last().system()).contains("- ship:");

        s.connection().onSetPlaybook(y.toString());
        turn(s, "two");

        assertThat(s.provider().last().system()).contains("- deploy: Deploy")
                .doesNotContain("- ship:").doesNotContain("team-x:").contains("- brainstorming: My own brainstorming");
        assertThat(tools(s.provider().last())).doesNotContain("spawn_named_agent");

        s.connection().onSetPlaybook(null);
        turn(s, "three");

        assertThat(s.provider().last().system()).doesNotContain("- deploy:").doesNotContain("- ship:")
                .contains("- brainstorming: My own brainstorming");
    }

    @Test
    void anotherSessionIsNotAffectedByOneSessionsPick() throws Exception {
        Path dir = teamX();
        Session picking = session("ws-558-a");
        Session other = session("ws-558-b");

        picking.connection().onSetPlaybook(dir.toString());
        turn(picking, "hello");
        turn(other, "hello");

        assertThat(picking.provider().last().system()).contains("- ship:");
        assertThat(other.provider().last().system()).doesNotContain("- ship:").doesNotContain("brainstorming");
        assertThat(tools(other.provider().last())).doesNotContain("spawn_named_agent");
    }

    @Test
    void aSlashTokenNamesAPlaybookCommandOrSkillAndTheModelReadsItsText() throws Exception {
        Path dir = teamX();
        Session s = session("ws-558-slash");
        s.connection().onSetPlaybook(dir.toString());

        turn(s, "/ship the export, /brainstorming first");

        String sent = userText(s.provider().last());
        assertThat(sent).contains(SHIP_BODY).contains("Ask one question at a time.");
    }

    @Test
    void aNamedAgentStartsFromThePlainChatOnItsPreamble() throws Exception {
        Path dir = teamX();
        Session s = session("ws-558-agent");
        s.connection().onSetPlaybook(dir.toString());
        s.provider().parentScript.add(call("spawn_named_agent", "{\"agent\":\"reviewer\",\"task\":\"Check the diff\"}"));

        turn(s, "review it");

        assertThat(s.provider().childRequests).isNotEmpty();
        assertThat(userText(s.provider().childRequests.getFirst())).contains(PREAMBLE).contains("Check the diff");
        assertThat(userText(s.provider().last())).contains("child done");
    }

    @Test
    void theSessionItemsFrameNamesEveryItemWithItsSourceOnAPickAndOnRequest() throws Exception {
        Path dir = teamX();
        usersBrainstorming();
        Session s = session("ws-558-frame");

        s.connection().onSetPlaybook(dir.toString());

        JsonNode frame = frames(s.socket(), "session_items").getLast();
        assertThat(frame.path("playbook").path("dir").asText()).isEqualTo(dir.toString());
        assertThat(frame.path("playbook").path("id").asText()).isEqualTo("team-x");
        assertThat(frame.path("playbook").path("name").asText()).isEqualTo("Team X");
        List<String> rows = new ArrayList<>();
        frame.path("items").forEach(i -> rows.add(i.path("kind").asText() + " " + i.path("name").asText() + " "
                + i.path("plain").asText() + " " + i.path("source").asText() + " " + i.path("namespace").asText()));
        assertThat(rows).contains(
                "skill team-x:brainstorming brainstorming playbook team-x",
                "skill user:brainstorming brainstorming user user",
                "skill tdd tdd playbook team-x",
                "command ship ship playbook team-x",
                "agent reviewer reviewer playbook team-x");
        assertThat(frame.path("items").get(0).has("description")).isTrue();

        s.connection().onSetPlaybook(null);
        JsonNode withdrawn = frames(s.socket(), "session_items").getLast();
        assertThat(withdrawn.path("playbook").isNull()).isTrue();
        List<String> names = new ArrayList<>();
        withdrawn.path("items").forEach(i -> names.add(i.path("name").asText()));
        assertThat(names).contains("brainstorming").doesNotContain("ship", "tdd", "reviewer");

        int before = frames(s.socket(), "session_items").size();
        s.connection().onGetSessionItems();
        assertThat(frames(s.socket(), "session_items")).hasSize(before + 1);
    }

    /**
     * A session imported from another machine can carry a pick of a folder the
     * registry does not know; nothing is read from it (card 554 fix round 1).
     */
    @Test
    void aWokenSessionWhosePickIsNotARegisteredFolderGetsNoItemsFromIt(@TempDir Path stranger) throws Exception {
        Files.writeString(stranger.resolve("playbook.json"), PLAYBOOK);
        Files.createDirectories(stranger.resolve("commands"));
        Files.writeString(stranger.resolve("commands/ship.md"), "---\ndescription: Ship the change\n---\n" + SHIP_BODY);
        String id = "20261012-230000-w558strn";
        Files.createDirectories(SessionStore.SESSIONS_DIR);
        Files.writeString(SessionStore.sessionFile(id),
                "{\"type\":\"run_start\",\"runId\":\"r1\",\"agentId\":\"main\",\"prompt\":\"A\",\"ts\":1}\n"
                        + "{\"type\":\"run_end\",\"runId\":\"r1\",\"stopReason\":\"end_turn\",\"ts\":2}\n"
                        + "{\"type\":\"playbook_picked\",\"dir\":" + JSON.writeValueAsString(stranger.toRealPath().toString())
                        + ",\"name\":\"Team X\",\"ts\":3}\n");
        sessions.add(id);
        FakeSocket socket = new FakeSocket("ws-558-stranger", "ws://localhost/ws");
        Recorder provider = new Recorder();
        SessionConnection connection = new SessionConnection(socket, JSON,
                SpectroConfig.load(new SpectroConfig.Overrides("ollama", "qwen3:8b", null, null, null,
                        workspace.toString())), null);
        connection.providerBuilderForTest(c -> provider);
        connection.start();
        connection.onWakeSession(id);
        Session s = new Session(connection, socket, provider);

        turn(s, "hello");

        assertThat(connection.playbookDir()).as("premise: the pick came back").isEqualTo(stranger.toRealPath().toString());
        assertThat(provider.last().system()).doesNotContain("- ship:");
        assertThat(frames(socket, "session_items").getLast().path("playbook").isNull()).isTrue();
    }

    @Test
    void readingThePlaybookNeverWritesUnderItsFolder() throws Exception {
        Path dir = teamX();
        String before = folderState(dir);
        Session s = session("ws-558-read");
        s.connection().onSetPlaybook(dir.toString());
        s.provider().parentScript.add(call("use_skill", "{\"name\":\"brainstorming\"}"));
        s.provider().parentScript.add(call("read_skill_file", "{\"skill\":\"brainstorming\",\"path\":\"example.md\"}"));

        turn(s, "/ship it");
        s.connection().onGetSessionItems();

        String seen = userText(s.provider().last());
        assertThat(seen).as("positive control: the reads happened")
                .contains("Ask one question at a time.").contains("an example dialogue").contains(SHIP_BODY);
        assertThat(folderState(dir)).as("a session only reads the playbook folder (criterion 4)").isEqualTo(before);
    }
}
