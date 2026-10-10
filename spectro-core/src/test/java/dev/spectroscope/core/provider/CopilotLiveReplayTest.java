package dev.spectroscope.core.provider;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ArrayNode;
import com.fasterxml.jackson.databind.node.ObjectNode;
import com.github.copilot.CopilotClient;
import com.github.copilot.rpc.CopilotClientOptions;
import dev.spectroscope.core.CancelSignal;
import dev.spectroscope.core.provider.LlmProvider.PStop;
import dev.spectroscope.core.provider.LlmProvider.PTextDelta;
import dev.spectroscope.core.provider.LlmProvider.PToolCall;
import dev.spectroscope.core.provider.LlmProvider.PUsage;
import dev.spectroscope.core.provider.LlmProvider.ProviderContent;
import dev.spectroscope.core.provider.LlmProvider.ProviderEvent;
import dev.spectroscope.core.provider.LlmProvider.ProviderMessage;
import dev.spectroscope.core.provider.LlmProvider.ProviderRequest;
import dev.spectroscope.core.provider.LlmProvider.TextContent;
import dev.spectroscope.core.provider.LlmProvider.ToolCallContent;
import dev.spectroscope.core.provider.LlmProvider.ToolResultContent;
import dev.spectroscope.core.provider.LlmProvider.ToolSpec;
import org.junit.jupiter.api.Test;

import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Instant;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.concurrent.TimeUnit;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assumptions.assumeTrue;

/**
 * Card 494, criterion 7: card 478's five prompts replayed through
 * {@link CopilotProvider} against the real, signed-in Copilot CLI, plus a
 * harness tool turn, a request for a shell command and a cancel.
 *
 * <p>Runs only when both {@code -Dcopilot.live.cli=<path to copilot>} and
 * {@code -Dcopilot.live.out=<dir>} are given; every other build skips it.
 * It uses the login the CLI stores, which is the user's choice made by
 * running it. Each prompt is billed to that account. The record it writes
 * holds no login: the login is read into memory only to replace it.</p>
 */
class CopilotLiveReplayTest {

    private static final ObjectMapper JSON = new ObjectMapper();
    private static final String SYSTEM = "You are a test assistant inside another program. Use the tools you are"
            + " given when the user asks for a fact they cover. Keep answers short.";
    private static final String[] PROMPTS = {
        "Name one primary color.",
        "What is 17 times 3? Reply with the number only.",
        "Give a synonym for quick.",
        "In which continent is Kenya?",
        "Write one short sentence about rain.",
    };

    @Test
    void replayCardFourSeventyEightThroughTheProvider() throws Exception {
        String cli = System.getProperty("copilot.live.cli");
        String out = System.getProperty("copilot.live.out");
        assumeTrue(cli != null && out != null, "live replay runs only with copilot.live.cli and copilot.live.out");
        String model = System.getProperty("copilot.live.model", "claude-sonnet-5");
        Path dir = Path.of(out);
        Files.createDirectories(dir);
        String login = login(cli);
        List<String> log = new ArrayList<>();
        ObjectNode summary = JSON.createObjectNode();
        summary.put("model", model);
        summary.put("method", "wall clock from creating the stream iterator (which sends the message; for"
                + " prompt 1 it also creates the runtime session) to the first PTextDelta, System.nanoTime,"
                + " one conversation, prompts in sequence");

        try (CopilotProvider provider = new CopilotProvider(new CopilotProvider.Options(model, cli, null, true))) {
            long t0 = System.nanoTime();
            List<CopilotProvider.CopilotModel> models = provider.models();
            line(log, "models(): " + models.size() + " models after " + ms(t0) + " ms (includes runtime start)");
            for (CopilotProvider.CopilotModel m : models) {
                line(log, "  model " + m.id() + " vision=" + m.vision() + " window=" + m.contextWindow());
            }
            summary.put("models", models.size());
            summary.put("contextWindow", provider.contextWindow());
            summary.put("vision", provider.vision().name());
            line(log, "runtime processes: " + runtimeProcesses());

            // The five prompts of card 478, one conversation.
            List<ProviderMessage> history = new ArrayList<>();
            ArrayNode ttft = summary.putArray("ttftMs");
            for (int i = 0; i < PROMPTS.length; i++) {
                history.add(user(PROMPTS[i]));
                long start = System.nanoTime();
                Long first = null;
                StringBuilder text = new StringBuilder();
                List<ProviderEvent> events = new ArrayList<>();
                for (ProviderEvent e : provider.stream(request(history, List.of(), new CancelSignal()))) {
                    events.add(e);
                    if (e instanceof PTextDelta d) {
                        if (first == null) {
                            first = (System.nanoTime() - start) / 1_000_000;
                        }
                        text.append(d.text());
                    }
                }
                ttft.add(first == null ? -1 : first);
                line(log, "prompt " + (i + 1) + " ttft_wall_ms=" + first + " total_ms=" + ms(start)
                        + " events=" + kinds(events) + " usage=" + usage(events) + " answer=" + json(text.toString()));
                assertEquals(new PStop(PStop.StopReason.END_TURN), events.getLast());
                history.add(new ProviderMessage(ProviderMessage.Role.ASSISTANT, List.of(new TextContent(text.toString()))));
            }

            // A harness tool turn: the provider yields the call, the harness answers 5 s later.
            ToolSpec lookup = new ToolSpec("lookup_capital", "Returns the capital city of a country.",
                    JSON.valueToTree(Map.of("type", "object", "properties", Map.of("country", Map.of("type", "string")),
                            "required", List.of("country"))));
            List<ProviderMessage> tools = new ArrayList<>(List.of(user(
                    "What is the capital of France? Use the lookup_capital tool, then answer in one sentence.")));
            long toolStart = System.nanoTime();
            List<ProviderEvent> first = drain(provider.stream(request(tools, List.of(lookup), new CancelSignal())));
            line(log, "tool turn stream 1 after " + ms(toolStart) + " ms: " + kinds(first) + " usage=" + usage(first)
                    + " calls=" + calls(first));
            assertEquals(new PStop(PStop.StopReason.TOOL_USE), first.getLast());
            List<ProviderContent> assistant = new ArrayList<>();
            List<ProviderContent> results = new ArrayList<>();
            for (ProviderEvent e : first) {
                if (e instanceof PToolCall c) {
                    assistant.add(new ToolCallContent(c.callId(), c.name(), c.input()));
                    String country = c.input().path("country").asText();
                    results.add(new ToolResultContent(c.callId(),
                            country.equalsIgnoreCase("France") ? "Paris" : "unknown", false));
                }
            }
            line(log, "harness runs lookup_capital itself, waiting 5 s");
            TimeUnit.SECONDS.sleep(5);
            tools.add(new ProviderMessage(ProviderMessage.Role.ASSISTANT, assistant));
            tools.add(new ProviderMessage(ProviderMessage.Role.USER, results));
            long secondStart = System.nanoTime();
            List<ProviderEvent> second = drain(provider.stream(request(tools, List.of(lookup), new CancelSignal())));
            line(log, "tool turn stream 2 after " + ms(secondStart) + " ms: " + kinds(second) + " usage="
                    + usage(second) + " answer=" + json(text(second)));
            assertEquals(new PStop(PStop.StopReason.END_TURN), second.getLast());
            summary.put("toolTurnAnswer", text(second));

            // A shell command with no shell tool on offer.
            List<ProviderMessage> shell = List.of(user("Run the shell command `ls` in the current directory and"
                    + " report the output. If you have no tool that can run shell commands, reply exactly NO_SHELL_TOOL."));
            List<ProviderEvent> shellEvents = drain(provider.stream(request(shell, List.of(lookup), new CancelSignal())));
            line(log, "shell request: " + kinds(shellEvents) + " answer=" + json(text(shellEvents)));
            summary.put("shellAnswer", text(shellEvents));
            assertFalse(shellEvents.stream().anyMatch(e -> e instanceof PToolCall), "no tool call for ls");

            // Cancel on the first delta.
            CancelSignal signal = new CancelSignal();
            List<ProviderEvent> cancelled = new ArrayList<>();
            long cancelAt = 0;
            for (ProviderEvent e : provider.stream(request(List.of(user("Write a 600 word essay about lighthouses.")),
                    List.of(), signal))) {
                cancelled.add(e);
                if (e instanceof PTextDelta && !signal.isCancelled()) {
                    cancelAt = System.nanoTime();
                    signal.cancel();
                }
            }
            long cancelToStop = ms(cancelAt); // read once: the log line and the summary carry the same number
            line(log, "cancel: stop after " + cancelToStop + " ms from cancel(), events=" + kinds(cancelled));
            assertEquals(new PStop(PStop.StopReason.ABORTED), cancelled.getLast());
            summary.put("cancelToStopMs", cancelToStop);
            line(log, "runtime processes before close: " + runtimeProcesses());
        }
        long closed = System.nanoTime();
        int left = runtimeProcesses().size();
        while (left > 0 && ms(closed) < 10_000) {
            TimeUnit.MILLISECONDS.sleep(100);
            left = runtimeProcesses().size();
        }
        line(log, "runtime processes after close: " + left + " (checked for " + ms(closed) + " ms)");
        summary.put("runtimeProcessesAfterClose", left);
        assertEquals(0, left, "the runtime stops when the provider closes");

        String record = redact(String.join("\n", log) + "\n", login);
        String summaryText = redact(JSON.writerWithDefaultPrettyPrinter().writeValueAsString(summary) + "\n", login);
        Files.writeString(dir.resolve("live-replay.log"), record, StandardCharsets.UTF_8);
        Files.writeString(dir.resolve("live-replay-summary.json"), summaryText, StandardCharsets.UTF_8);
        assertFalse(login != null && (record + summaryText).toLowerCase(Locale.ROOT)
                .contains(login.toLowerCase(Locale.ROOT)), "the record holds no login");
    }

    /** The login, read into memory only to keep it out of the record. */
    private static String login(String cli) throws Exception {
        Map<String, String> env = CopilotProvider.runtimeEnvironment(System.getenv());
        try (CopilotClient client = new CopilotClient(new CopilotClientOptions().setCliPath(cli)
                .setUseLoggedInUser(true).setEnvironment(env).setLogLevel("warning"))) {
            client.start().get(60, TimeUnit.SECONDS);
            String login = client.getAuthStatus().get(30, TimeUnit.SECONDS).getLogin();
            client.stop().get(30, TimeUnit.SECONDS);
            return login;
        }
    }

    private static String redact(String text, String login) {
        String home = System.getenv("HOME");
        String out = home == null ? text : text.replace(home, "~");
        if (login != null && !login.isBlank()) {
            out = out.replaceAll("(?i)" + java.util.regex.Pattern.quote(login), "<login>");
        }
        return out;
    }

    private static List<String> runtimeProcesses() {
        return ProcessHandle.current().descendants().filter(ProcessHandle::isAlive)
                .map(p -> p.info().command().orElse("?"))
                .filter(c -> c.contains("copilot"))
                .map(c -> c.substring(c.lastIndexOf('/') + 1))
                .toList();
    }

    private static ProviderRequest request(List<ProviderMessage> history, List<ToolSpec> tools, CancelSignal signal) {
        return new ProviderRequest(SYSTEM, List.copyOf(history), tools, 4096, signal);
    }

    private static ProviderMessage user(String text) {
        return new ProviderMessage(ProviderMessage.Role.USER, List.of(new TextContent(text)));
    }

    private static List<ProviderEvent> drain(Iterable<ProviderEvent> stream) {
        List<ProviderEvent> events = new ArrayList<>();
        stream.forEach(events::add);
        return events;
    }

    private static String text(List<ProviderEvent> events) {
        StringBuilder text = new StringBuilder();
        events.stream().filter(e -> e instanceof PTextDelta).forEach(e -> text.append(((PTextDelta) e).text()));
        return text.toString();
    }

    private static String kinds(List<ProviderEvent> events) {
        Map<String, Integer> counts = new java.util.LinkedHashMap<>();
        events.forEach(e -> counts.merge(e.getClass().getSimpleName(), 1, Integer::sum));
        PStop stop = (PStop) events.stream().filter(e -> e instanceof PStop).reduce((a, b) -> b).orElse(null);
        return counts + (stop == null ? "" : " stop=" + stop.reason());
    }

    private static String usage(List<ProviderEvent> events) {
        return events.stream().filter(e -> e instanceof PUsage).map(Object::toString).toList().toString();
    }

    private static String calls(List<ProviderEvent> events) {
        return events.stream().filter(e -> e instanceof PToolCall)
                .map(e -> ((PToolCall) e).name() + ((PToolCall) e).input()).toList().toString();
    }

    private static String json(String value) throws Exception {
        return JSON.writeValueAsString(value);
    }

    private static long ms(long start) {
        return (System.nanoTime() - start) / 1_000_000;
    }

    private static void line(List<String> log, String text) {
        log.add(Instant.now() + " " + text);
    }
}
