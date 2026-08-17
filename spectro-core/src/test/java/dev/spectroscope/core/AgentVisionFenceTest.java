package dev.spectroscope.core;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import dev.spectroscope.core.events.RunEvent;
import dev.spectroscope.core.provider.LlmProvider;
import dev.spectroscope.core.provider.LlmProvider.ImageContent;
import dev.spectroscope.core.provider.LlmProvider.PStop;
import dev.spectroscope.core.provider.LlmProvider.PTextDelta;
import dev.spectroscope.core.provider.LlmProvider.PToolCall;
import dev.spectroscope.core.provider.LlmProvider.PUsage;
import dev.spectroscope.core.provider.LlmProvider.ProviderContent;
import dev.spectroscope.core.provider.LlmProvider.ProviderEvent;
import dev.spectroscope.core.provider.LlmProvider.ProviderMessage;
import dev.spectroscope.core.provider.LlmProvider.ProviderRequest;
import dev.spectroscope.core.provider.LlmProvider.TextContent;
import dev.spectroscope.core.provider.VisionFence;
import dev.spectroscope.core.session.SessionStore;
import dev.spectroscope.core.tools.Tool;
import dev.spectroscope.core.tools.ToolRegistry;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.Timeout;

import java.io.IOException;
import java.nio.file.Path;
import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.List;
import java.util.Queue;
import java.util.UUID;
import java.util.concurrent.TimeUnit;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * Card 252, the fence: an image handed to a model that cannot see used to
 * poison the whole session.
 *
 * <p>Measured on the owner's desktop 2026-08-17: a pasted screenshot at
 * deepseek-v4-flash came back as HTTP 400 "does not support image inputs", and
 * because the image lives in the agent's history it was re-sent on every later
 * turn — so every later prompt failed the same way and the session was wedged
 * for good. Two facts have to hold at once here, and they pull in opposite
 * directions: the attachment stays in the RECORD (the session file and the
 * user's own bubble keep it), while the provider REQUEST is built without it.
 * That is why the filter sits at request build and not in the history.</p>
 */
@Timeout(value = 10, unit = TimeUnit.SECONDS)
class AgentVisionFenceTest {

    private static final byte[] PNG = {(byte) 0x89, 'P', 'N', 'G'};

    private static final ObjectMapper JSON = new ObjectMapper();

    /** Answers what the harness knows about its model's sight, and records
     *  every request it was handed — the request IS the assertion here.
     *
     *  <p>Turns come off a script when one is loaded, so a run can be driven
     *  through several turns (and through compaction); an empty script answers
     *  with one plain text turn, which is what most of these tests want.</p> */
    private static final class SightedProvider implements LlmProvider {
        final List<ProviderRequest> requests = new ArrayList<>();
        final Queue<List<ProviderEvent>> script = new ArrayDeque<>();
        private final Vision vision;
        private final String model;

        SightedProvider(Vision vision, String model) {
            this.vision = vision;
            this.model = model;
        }

        @Override
        public Vision vision() {
            return vision;
        }

        @Override
        public String modelName() {
            return model;
        }

        @Override
        public Iterable<ProviderEvent> stream(ProviderRequest request) {
            requests.add(request);
            List<ProviderEvent> scripted = script.poll();
            return scripted != null ? scripted
                    : List.of(new PTextDelta("answered"), new PStop(PStop.StopReason.END_TURN));
        }
    }

    /** One echo tool call, so a scripted turn can hand the loop real work and
     *  earn a SECOND turn; inputTokens feeds the compaction trigger. */
    private static List<ProviderEvent> toolTurn(String callId, int inputTokens) {
        return List.of(new PToolCall(callId, "echo", JSON.createObjectNode().put("value", callId)),
                new PUsage(inputTokens, 2),
                new PStop(PStop.StopReason.TOOL_USE));
    }

    /** A turn that answers and ends the run. */
    private static List<ProviderEvent> textTurn(String text) {
        return List.of(new PTextDelta(text), new PUsage(5, 2),
                new PStop(PStop.StopReason.END_TURN));
    }

    /** A permissionless echo tool so scripted tool turns have something to run. */
    private static Tool echoTool() {
        return new Tool() {
            public String name() { return "echo"; }
            public String description() { return "echoes"; }
            public JsonNode inputSchema() { return JSON.createObjectNode(); }
            public boolean needsPermission() { return false; }
            public String execute(JsonNode input, ToolContext context) { return "ok"; }
        };
    }

    private static Agent agentWith(LlmProvider provider, List<ProviderMessage> initial) {
        return agentWith(provider, initial, null);
    }

    private static Agent agentWith(LlmProvider provider, List<ProviderMessage> initial,
                                   Integer compactionThreshold) {
        ToolRegistry registry = new ToolRegistry();
        registry.register(echoTool());
        AgentOptions.Builder builder = AgentOptions.builder()
                .provider(provider)
                .systemPrompt("test")
                .registry(registry)
                .cwd(Path.of("."))
                .agentId("main")
                .onPermission(request -> true)
                .initialMessages(initial);
        if (compactionThreshold != null) {
            builder.compactionThreshold(compactionThreshold);
        }
        return new Agent(builder.build());
    }

    private static List<RunEvent> run(Agent agent, String prompt,
                                     List<RunEvent.Attachment> attachments) {
        List<RunEvent> events = new ArrayList<>();
        try (EventStream stream = agent.run(prompt, new RunOptions(new CancelSignal(), attachments))) {
            stream.forEach(events::add);
        }
        return events;
    }

    private static String freshId() {
        return "card252-" + UUID.randomUUID().toString().substring(0, 8);
    }

    private static List<ProviderContent> firstUserContent(SightedProvider provider) {
        return provider.requests.getFirst().messages().getFirst().content();
    }

    private static long imagesIn(ProviderRequest request) {
        return request.messages().stream()
                .flatMap(message -> message.content().stream())
                .filter(ImageContent.class::isInstance)
                .count();
    }

    // ---- (a) the send-side fence ------------------------------------------

    @Test
    void aModelThatCannotSeeNeverReceivesTheImage() {
        SessionStore.StoredBlob blob = SessionStore.saveBlob(freshId(), PNG, "image/png");
        RunEvent.Attachment screenshot =
                new RunEvent.Attachment("image", "image/png", blob.blobPath(), blob.sha256());
        SightedProvider provider =
                new SightedProvider(LlmProvider.Vision.BLIND, "deepseek-v4-flash");

        List<RunEvent> events = run(agentWith(provider, null),
                "What is on this screenshot?", List.of(screenshot));

        // The record keeps the attachment — run_start is what the session file
        // and the user's bubble are built from, and neither may lose the image.
        RunEvent.RunStart start = (RunEvent.RunStart) events.getFirst();
        assertEquals(List.of(screenshot), start.attachments(),
                "the attachment stays in the record; only the request drops it");

        // The request does not.
        assertEquals(0, imagesIn(provider.requests.getFirst()),
                "a model that cannot see must never receive image content");
        assertTrue(firstUserContent(provider).stream()
                        .anyMatch(content -> content instanceof TextContent text
                                && text.text().equals("What is on this screenshot?")),
                "the prompt itself still travels");
        // The model is TOLD, or it answers about a picture it never saw — the
        // same argument the ollama document arm makes for failing loudly.
        assertTrue(firstUserContent(provider).stream()
                        .anyMatch(content -> content instanceof TextContent text
                                && text.text().contains("cannot process images")),
                "the withheld image leaves a marker the model can read");

        // One honest line on the record, and the run ENDED — it did not error.
        List<RunEvent.ImagesWithheld> lines = events.stream()
                .filter(RunEvent.ImagesWithheld.class::isInstance)
                .map(RunEvent.ImagesWithheld.class::cast)
                .toList();
        assertEquals(1, lines.size(), "exactly one refusal line per run");
        assertEquals(1, lines.getFirst().images());
        assertEquals("deepseek-v4-flash", lines.getFirst().model());
        assertEquals("no_vision", lines.getFirst().reason());
        assertFalse(events.stream().anyMatch(RunEvent.ErrorEvent.class::isInstance),
                "the refusal is a line, not a failed run");
        assertEquals("end_turn", ((RunEvent.RunEnd) events.getLast()).stopReason());
    }

    @Test
    void aModelWhoseSightIsUnknownStillGetsTheImage() {
        // The safe direction, pinned. Withholding on a guess would blind every
        // vision model the harness cannot interrogate — an unknown capability is
        // not a refusal, and only the provider may answer this question.
        SessionStore.StoredBlob blob = SessionStore.saveBlob(freshId(), PNG, "image/png");
        SightedProvider provider =
                new SightedProvider(LlmProvider.Vision.UNKNOWN, "some-new-model");

        List<RunEvent> events = run(agentWith(provider, null), "Look at this",
                List.of(new RunEvent.Attachment("image", "image/png",
                        blob.blobPath(), blob.sha256())));

        assertEquals(1, imagesIn(provider.requests.getFirst()),
                "unknown sight sends the image — the provider decides, not a guess");
        assertFalse(events.stream().anyMatch(RunEvent.ImagesWithheld.class::isInstance),
                "nothing was withheld, so nothing is claimed");
    }

    // ---- (b) the un-wedging ----------------------------------------------

    @Test
    void aSessionWhoseRecordCarriesAnImageStillRunsOnAModelThatCannotSee() throws IOException {
        // The owner's wedge, rebuilt from a REAL session file: run_start carries
        // the attachment, so resume re-expands it into the history before the
        // prompt text (SessionStore.loadSession) — and from there every later
        // turn re-uploaded it. The next prompt has to work anyway.
        String id = freshId();
        SessionStore.StoredBlob blob = SessionStore.saveBlob(id, PNG, "image/png");
        SessionStore store = new SessionStore(id);
        store.append(new RunEvent.RunStart("r1", "main", null, "What is on this screenshot?",
                "openai", List.of(new RunEvent.Attachment("image", "image/png",
                        blob.blobPath(), blob.sha256())), 1L));
        store.append(new RunEvent.TurnStart("main", 1, 2L));
        store.append(new RunEvent.ErrorEvent("main", "OpenAI-compatible server HTTP 400: "
                + "The provided messages contain images, but deepseek-v4-flash "
                + "does not support image inputs", 3L));
        store.append(new RunEvent.RunEnd("r1", "error", 4L));

        List<ProviderMessage> resumed = SessionStore.loadSession(id);
        assertEquals(1, resumed.stream()
                        .flatMap(message -> message.content().stream())
                        .filter(ImageContent.class::isInstance)
                        .count(),
                "premise: the resumed history really carries the image");

        SightedProvider provider =
                new SightedProvider(LlmProvider.Vision.BLIND, "deepseek-v4-flash");
        List<RunEvent> events = run(agentWith(provider, resumed),
                "forget the picture — list the files", null);

        assertEquals(0, imagesIn(provider.requests.getFirst()),
                "the wedge: an image in the HISTORY must not reach a blind model either");
        assertEquals("end_turn", ((RunEvent.RunEnd) events.getLast()).stopReason(),
                "the next prompt runs — the session is not poisoned");
        assertTrue(events.stream().anyMatch(RunEvent.ImagesWithheld.class::isInstance),
                "and it says so, even though this prompt attached nothing");
    }

    @Test
    void theRefusalIsSaidOncePerRunAndNotOncePerTurn() {
        // The image sits in the history, so every turn of a tool-using run
        // withholds it again. A line per turn would bury the transcript.
        //
        // This needs a run that really takes several turns, or it pins nothing:
        // with a provider that ends the turn immediately the loop asks once, and
        // "one line" is true whether the flag exists or not. So the script runs
        // two tool rounds before it answers — three provider calls, three closings
        // of the fence, and a per-turn line would be three lines.
        SessionStore.StoredBlob blob = SessionStore.saveBlob(freshId(), PNG, "image/png");
        SightedProvider provider =
                new SightedProvider(LlmProvider.Vision.BLIND, "deepseek-v4-flash");
        provider.script.add(toolTurn("c1", 5));
        provider.script.add(toolTurn("c2", 5));
        provider.script.add(textTurn("done"));

        List<RunEvent> events = run(agentWith(provider, List.of(
                        new ProviderMessage(ProviderMessage.Role.USER, List.of(
                                new ImageContent("image/png", "aWJt"),
                                new TextContent("what is this?"))))),
                "and now?", List.of(new RunEvent.Attachment("image", "image/png",
                        blob.blobPath(), blob.sha256())));

        assertEquals(3, provider.requests.size(),
                "premise: three turns — otherwise once-per-run and once-per-turn are the same thing");
        provider.requests.forEach(request -> assertEquals(0, imagesIn(request),
                "every turn is fenced, not just the first"));
        assertEquals(1, events.stream()
                        .filter(RunEvent.ImagesWithheld.class::isInstance)
                        .count(),
                "one line per run");
        assertEquals(2, events.stream()
                        .filter(RunEvent.ImagesWithheld.class::isInstance)
                        .map(RunEvent.ImagesWithheld.class::cast)
                        .findFirst().orElseThrow().images(),
                "and it counts every image it kept back, history and prompt alike");
    }

    // ---- (c) the second request nobody fenced ------------------------------

    @Test
    void theCompactionSummarizerNeverHandsAnImageToABlindModel() {
        // The hole an adversarial verifier found after the branch was built: the
        // fence sat where the TURN request is assembled, and the compaction
        // summarizer assembles its own request out of the same history. A long
        // session on a blind model therefore still wedged — later, at compaction
        // time, instead of on the first turn.
        //
        // Three tool rounds grow the history past the kept window while the usage
        // events hold the trigger over the threshold; turn 4 compacts (the
        // summarizer pops the fourth scripted turn) and then answers.
        SightedProvider provider =
                new SightedProvider(LlmProvider.Vision.BLIND, "deepseek-v4-flash");
        provider.script.add(toolTurn("c1", 100));
        provider.script.add(toolTurn("c2", 100));
        provider.script.add(toolTurn("c3", 100));
        provider.script.add(textTurn("summary of everything so far"));
        provider.script.add(textTurn("done"));

        List<RunEvent> events = run(agentWith(provider, List.of(
                        new ProviderMessage(ProviderMessage.Role.USER, List.of(
                                new ImageContent("image/png", "aWJt"),
                                new TextContent("what is on this screenshot?")))), 10),
                "keep going", null);

        assertTrue(events.stream().anyMatch(RunEvent.Compaction.class::isInstance),
                "premise: the scripted run must really compact");
        ProviderRequest summarizer = provider.requests.stream()
                .filter(request -> request.system().contains("note-taker"))
                .findFirst().orElseThrow(() -> new AssertionError(
                        "premise: the summarizer's own call must be among the requests"));
        assertEquals(0, imagesIn(summarizer),
                "the summarizer builds its own request — and it must be fenced too");
        assertTrue(summarizer.messages().stream()
                        .flatMap(message -> message.content().stream())
                        .anyMatch(piece -> piece instanceof TextContent text
                                && text.text().equals(VisionFence.WITHHELD_MARKER)),
                "and it is told what it did not get, or the summary invents a screenshot");
        provider.requests.forEach(request -> assertEquals(0, imagesIn(request),
                "no request of this run may carry an image — turn or summary"));
        assertEquals(1, events.stream()
                        .filter(RunEvent.ImagesWithheld.class::isInstance)
                        .count(),
                "still one honest line, said by the turn path before compaction can fire");
        assertEquals("end_turn", ((RunEvent.RunEnd) events.getLast()).stopReason());
    }
}
