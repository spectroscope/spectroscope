package dev.spectroscope.core.playbook.run;

import dev.spectroscope.core.Asker;
import dev.spectroscope.core.CancelSignal;
import dev.spectroscope.core.PermissionBroker;
import dev.spectroscope.core.events.RunEvent;
import dev.spectroscope.core.playbook.Playbook;
import dev.spectroscope.core.provider.LlmProvider;
import dev.spectroscope.core.provider.SwitchableProvider;

import java.nio.file.Path;
import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.Deque;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.function.Consumer;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/** A host with no server: scripted chat turns, scripted probes, scripted answers. */
final class FakeHost implements PlaybookHost {

    private static final Pattern STEP_ID = Pattern.compile("\\(([a-z0-9_-]+)\\)\\.");

    final Path workspace;
    final CancelSignal signal = new CancelSignal();
    final List<RunEvent> events = new CopyOnWriteArrayList<>();
    final List<String> chatTurns = new ArrayList<>();
    final List<String> switches = new ArrayList<>();
    final List<String> floors = new ArrayList<>();
    final List<String> probed = new ArrayList<>();
    final Map<String, Consumer<FakeHost>> onChat = new HashMap<>();
    final Map<String, Probe> rows = new HashMap<>();
    final Map<String, String> answers = new HashMap<>();
    final Deque<String> answerQueue = new ArrayDeque<>();
    boolean nobodyToAsk;
    Playbook.ModelRef chat = new Playbook.ModelRef("lmstudio", "start-model");

    FakeHost(Path workspace) {
        this.workspace = workspace;
        rows.put("anthropic", new Probe("anthropic", "cloud", "reachable", "https://api.anthropic.com", null, List.of(), false, 1L));
        rows.put("ollama", new Probe("ollama", "local", "reachable", "http://localhost:11434", null, List.of("qwen3:8b"), true, 1L));
        rows.put("lmstudio", new Probe("lmstudio", "local", "reachable", "http://localhost:1234", null, List.of(), false, 1L));
    }

    @Override public Path workspace() { return workspace; }
    @Override public void emit(RunEvent event) { events.add(event); }

    @Override
    public ChatTurn chatTurn(String recordPrompt, String modelPrompt, CancelSignal signal) {
        Matcher m = STEP_ID.matcher(recordPrompt);
        String id = m.find() ? m.group(1) : "?";
        chatTurns.add(id + "@" + chat.provider());
        Consumer<FakeHost> action = onChat.get(id);
        if (action != null) {
            action.accept(this);
        }
        return new ChatTurn(signal.isCancelled() ? "aborted" : "end_turn", "ok");
    }

    @Override public Playbook.ModelRef chatModel() { return chat; }

    @Override
    public String switchChat(Playbook.ModelRef ref) {
        switches.add(ref.provider() + "/" + ref.model());
        chat = ref;
        return null;
    }

    @Override
    public LlmProvider providerFor(Playbook.ModelRef ref) {
        return new SwitchableProvider(new StepChildOnGraphTest.OneTurn(ref.model(), "built"), ref.provider());
    }

    @Override
    public Probe probe(String provider) {
        probed.add(provider);
        return rows.get(provider);
    }

    @Override public String kindOf(String provider) { return rows.get(provider).kind(); }
    @Override public void permissionFloor(String mode) { floors.add(String.valueOf(mode)); }
    @Override public PermissionBroker broker() { return request -> true; }

    @Override
    public Asker asker() {
        if (nobodyToAsk) {
            return null;
        }
        return question -> {
            String text = question.questions().get(0).question();
            String scripted = answerQueue.isEmpty() ? null : answerQueue.poll();
            for (Map.Entry<String, String> e : answers.entrySet()) {
                if (text.contains(e.getKey())) {
                    scripted = e.getValue();
                }
            }
            return scripted == null ? null : new Asker.Answer(List.of(scripted));
        };
    }
}
