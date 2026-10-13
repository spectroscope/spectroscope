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
import java.util.function.Predicate;
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
    /** Card 506: every chat turn's record prompt, and the replies the turns give in order ("ok" when empty). */
    final List<String> prompts = new CopyOnWriteArrayList<>();
    final Deque<String> replies = new ArrayDeque<>();
    /** Card 506 fix round 2: the stop reasons the turns give in order ("end_turn" when empty). */
    final Deque<String> stopReasons = new ArrayDeque<>();
    /** Card 506: a turn that ends normally even when its signal was cancelled, so only the runner can stop. */
    boolean turnsIgnoreCancel;
    boolean nobodyToAsk;
    Playbook.ModelRef chat = new Playbook.ModelRef("lmstudio", "start-model");
    /** Card 586: the next event this matches throws "emit broke" and is not kept; null for none. */
    Predicate<RunEvent> failEmit;
    /** Card 586: kindOf throws this when set. */
    RuntimeException failKindOf;
    /** Card 586: a chat switch to this provider throws "switch broke"; null for none. */
    String failSwitchTo;
    /** Card 586: runs when a question whose text holds the key is asked, before the scripted answer. */
    final Map<String, Consumer<FakeHost>> onAsk = new HashMap<>();

    FakeHost(Path workspace) {
        this.workspace = workspace;
        rows.put("anthropic", new Probe("anthropic", "cloud", "reachable", "https://api.anthropic.com", null, List.of(), false, 1L));
        rows.put("ollama", new Probe("ollama", "local", "reachable", "http://localhost:11434", null, List.of("qwen3:8b"), true, 1L));
        rows.put("lmstudio", new Probe("lmstudio", "local", "reachable", "http://localhost:1234", null, List.of(), false, 1L));
    }

    @Override public Path workspace() { return workspace; }

    @Override
    public void emit(RunEvent event) {
        Predicate<RunEvent> fail = failEmit;
        if (fail != null && fail.test(event)) {
            failEmit = null;
            throw new IllegalStateException("emit broke");
        }
        events.add(event);
    }

    @Override
    public ChatTurn chatTurn(String recordPrompt, String modelPrompt, CancelSignal signal) {
        prompts.add(recordPrompt);
        Matcher m = STEP_ID.matcher(recordPrompt);
        String id = m.find() ? m.group(1) : "?";
        chatTurns.add(id + "@" + chat.provider());
        Consumer<FakeHost> action = onChat.get(id);
        if (action != null) {
            action.accept(this);
        }
        String reply = replies.isEmpty() ? "ok" : replies.poll();
        String stop = stopReasons.isEmpty() ? "end_turn" : stopReasons.poll();
        return new ChatTurn(signal.isCancelled() && !turnsIgnoreCancel ? "aborted" : stop, reply);
    }

    @Override public Playbook.ModelRef chatModel() { return chat; }

    @Override
    public String switchChat(Playbook.ModelRef ref) {
        if (ref.provider().equals(failSwitchTo)) {
            throw new IllegalStateException("switch broke");
        }
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

    @Override
    public String kindOf(String provider) {
        if (failKindOf != null) {
            throw failKindOf;
        }
        return rows.get(provider).kind();
    }
    @Override public void permissionFloor(String mode) { floors.add(String.valueOf(mode)); }
    @Override public PermissionBroker broker() { return request -> true; }

    @Override
    public Asker asker() {
        if (nobodyToAsk) {
            return null;
        }
        return question -> {
            String text = question.questions().get(0).question();
            onAsk.forEach((key, action) -> {
                if (text.contains(key)) {
                    action.accept(this);
                }
            });
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
