package dev.spectroscope.cli;

import dev.spectroscope.core.commands.CommandList;
import dev.spectroscope.core.config.SettingsWriter;
import dev.spectroscope.core.events.RunEvent;
import dev.spectroscope.core.session.SessionStore;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.Timeout;
import org.junit.jupiter.api.io.TempDir;
import picocli.CommandLine;

import java.io.BufferedReader;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.PrintStream;
import java.io.StringReader;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.TimeUnit;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * Card 554 on the terminal REPL: {@code /help} is printed from the one command
 * list, every REPL row of that list reaches a handler, every web-only row
 * answers "web only", and {@code /clear} keeps the session as the web chat
 * does.
 */
@Timeout(value = 90, unit = TimeUnit.SECONDS, threadMode = Timeout.ThreadMode.SEPARATE_THREAD)
class ReplCommandsTest {

    private static final String SETTINGS = "{\"provider\": \"ollama\", \"model\": \"qwen3:latest\"}";

    private static SpectroCli interactive(Path workspace) {
        SpectroCli cli = new SpectroCli();
        new CommandLine(cli).parseArgs("--workspace", workspace.toString());
        cli.anchorAt(workspace);
        cli.openInteractiveSession(new BufferedReader(new StringReader("")));
        return cli;
    }

    private static String saveForUser(String json) throws IOException {
        Path file = SettingsWriter.userSettingsFile();
        String previous = Files.exists(file) ? Files.readString(file) : null;
        Files.createDirectories(file.getParent());
        Files.writeString(file, json);
        return previous;
    }

    private static void restore(String previous) throws IOException {
        Path file = SettingsWriter.userSettingsFile();
        if (previous == null) {
            Files.deleteIfExists(file);
        } else {
            Files.writeString(file, previous);
        }
    }

    /** What one slash command prints. */
    private static String said(SpectroCli cli, String line) {
        PrintStream original = System.out;
        ByteArrayOutputStream buffer = new ByteArrayOutputStream();
        System.setOut(new PrintStream(buffer, true, StandardCharsets.UTF_8));
        try {
            cli.handleSlashCommand(line);
        } finally {
            System.setOut(original);
        }
        return buffer.toString(StandardCharsets.UTF_8);
    }

    private static List<CommandList.Command> replRows() {
        return CommandList.all().stream().filter(c -> c.wired() && c.onRepl()).toList();
    }

    private static List<CommandList.Command> webOnlyRows() {
        return CommandList.all().stream().filter(c -> c.wired() && c.onWeb() && !c.onRepl()).toList();
    }

    @Test
    void helpIsPrintedFromTheListWithTheWebRowsUnderTheirOwnHeading() {
        List<String> lines = SpectroCli.helpText();
        String text = String.join("\n", lines);
        int web = lines.indexOf("In the web chat (web only)");
        assertTrue(web > 0, "the web-only rows have their heading: " + text);
        assertFalse(replRows().isEmpty());
        assertFalse(webOnlyRows().isEmpty());
        for (CommandList.Command c : replRows()) {
            int at = indexOfRow(lines, c);
            assertTrue(at > 0 && at < web, c.id() + " is listed above the web heading:\n" + text);
            assertTrue(lines.get(at).endsWith(c.help().en()), lines.get(at));
        }
        for (CommandList.Command c : webOnlyRows()) {
            int at = indexOfRow(lines, c);
            assertTrue(at > web, c.id() + " is listed below the web heading:\n" + text);
            assertTrue(lines.get(at).endsWith(c.help().en()), lines.get(at));
        }
        assertTrue(text.contains("/peer"), "card 554: /peer has its line");
        assertTrue(text.contains("/help, /commands"), "an alias is named beside its command");
        assertFalse(text.contains("/codegraph"), "a row another card owns is not listed yet");
        assertFalse(text.contains("new file"), "the old /clear text is gone");
    }

    /** The line of a row: the one that starts with its slash spelling. */
    private static int indexOfRow(List<String> lines, CommandList.Command c) {
        for (int i = 0; i < lines.size(); i++) {
            if (lines.get(i).strip().startsWith("/" + c.spelling() + " ")
                    || lines.get(i).strip().startsWith("/" + c.spelling() + ",")) {
                return i;
            }
        }
        return -1;
    }

    @Test
    void theInputLoopKeepsExitVoiceAndSpeakAndSendsEverySlashOnward() {
        assertEquals(SpectroCli.ReplRoute.EXIT, SpectroCli.route("/exit"));
        assertEquals(SpectroCli.ReplRoute.EXIT, SpectroCli.route(""));
        assertEquals(SpectroCli.ReplRoute.VOICE, SpectroCli.route("/voice"));
        assertEquals(SpectroCli.ReplRoute.SPEAK, SpectroCli.route("/speak on"));
        assertEquals(SpectroCli.ReplRoute.SLASH, SpectroCli.route("/speak"));
        assertEquals(SpectroCli.ReplRoute.SLASH, SpectroCli.route("/playbook list"));
        assertEquals(SpectroCli.ReplRoute.PROMPT, SpectroCli.route("add a CSV export"));
    }

    @Test
    void everyReplRowReachesAHandlerAndEveryWebRowAnswersWebOnly(@TempDir Path workspace) throws IOException {
        String previous = saveForUser(SETTINGS);
        try {
            SpectroCli cli = interactive(workspace);
            List<String> unhandled = new ArrayList<>();
            for (CommandList.Command c : replRows()) {
                List<String> spellings = new ArrayList<>(c.aliases());
                spellings.add(c.spelling());
                for (String s : spellings) {
                    SpectroCli.ReplRoute route = SpectroCli.route("/" + s);
                    if (route == SpectroCli.ReplRoute.EXIT || route == SpectroCli.ReplRoute.VOICE) {
                        continue; // the input loop itself handles these two
                    }
                    String out = said(cli, "/" + s);
                    if (out.contains("Unknown command") || out.strip().startsWith("web only:") || out.isBlank()) {
                        unhandled.add("/" + s + " -> " + out.strip());
                    }
                }
            }
            assertEquals(List.of(), unhandled);
            for (CommandList.Command c : webOnlyRows()) {
                List<String> spellings = new ArrayList<>(c.aliases());
                spellings.add(c.spelling());
                for (String s : spellings) {
                    String out = said(cli, "/" + s + (c.takesArgs() ? " add a CSV export" : ""));
                    assertEquals("web only: " + c.help().en(), out.strip(), "/" + s);
                }
            }
            assertTrue(said(cli, "/nope").contains("Unknown command: /nope"), "an unknown name stays unknown");
        } finally {
            restore(previous);
        }
    }

    @Test
    void clearKeepsTheSessionAndStartsAFreshContextAsTheWebDoes(@TempDir Path workspace) throws IOException {
        String previous = saveForUser(SETTINGS);
        try {
            SpectroCli cli = interactive(workspace);
            String id = cli.sessionId();
            SessionStore record = new SessionStore(id);
            record.append(new RunEvent.RunStart("r1", "main", null, "hello there", "ollama", "qwen3:latest",
                    List.of(), 1L));
            record.append(new RunEvent.TextDelta("main", "hi back", 2L));
            record.append(new RunEvent.RunEnd("r1", "end_turn", 3L));
            said(cli, "/think on"); // rebuilds the agent from the file, so it holds the two messages
            assertEquals(2, SessionStore.loadSession(id).size(), "premise: the history holds the first turn");

            String out = said(cli, "/clear");

            assertEquals(id, cli.sessionId(), "the session keeps its id");
            assertTrue(out.contains("context cleared: 2 messages dropped"), out);
            assertTrue(Files.readString(SessionStore.sessionFile(id)).contains("\"type\":\"context_cleared\""),
                    "the marker is in the file");
            assertEquals(List.of(), SessionStore.loadSession(id), "a resume starts after the marker");
        } finally {
            restore(previous);
        }
    }

    /**
     * Card 554 fix round 1: /clear keeps what the web's /clear keeps. A
     * running loop goes on, and since the model's history no longer holds the
     * loop's instructions, its next fire carries them in full again; a stated
     * goal stays stated.
     */
    @Test
    void aRunningLoopAndAStatedGoalSurviveClear(@TempDir Path workspace, @TempDir Path loops) throws Exception {
        String previous = saveForUser(SETTINGS);
        try {
            SpectroCli cli = interactive(workspace);
            ReplLoopTest.HandTimer timer = new ReplLoopTest.HandTimer();
            ReplLoop repl = new ReplLoop(timer, timer, new dev.spectroscope.core.loop.LoopSidecar(loops), () -> false,
                    line -> { });
            cli.loopForTests(repl);
            said(cli, "/goal set The export works.");
            said(cli, "/loop watch the build");
            dev.spectroscope.core.loop.LoopDriver loop = repl.driverIfAny();
            BufferedReader console = new BufferedReader(new StringReader(""));

            loop.schedule(120.0, "two minutes", dev.spectroscope.core.loop.LoopPrompts.SENTINEL, false);
            loop.runEnded();
            timer.advanceTo(timer.getAsLong() + 120_000L);
            ReplLoop.Fire first = repl.next(console).fire();
            assertTrue(first.model().startsWith(dev.spectroscope.core.loop.LoopPrompts.FULL_HEADING),
                    "premise: the first fire delivers the instructions in full");
            loop.schedule(120.0, "two minutes", dev.spectroscope.core.loop.LoopPrompts.SENTINEL, false);
            loop.runEnded();

            said(cli, "/clear");

            assertTrue(loop.active(), "the loop runs on after /clear");
            assertEquals("The export works.", cli.agent().goal().stated().outcome(), "the goal stays stated");
            assertTrue(Files.exists(dev.spectroscope.core.goal.GoalStore.fileFor(cli.sessionId())));
            timer.advanceTo(timer.getAsLong() + 120_000L);
            ReplLoop.Fire next = repl.next(console).fire();
            assertTrue(next.model().startsWith(dev.spectroscope.core.loop.LoopPrompts.FULL_HEADING),
                    "the history lost the instructions, so the next fire carries them again: " + next.model());
            loop.userAbort();
            Files.deleteIfExists(dev.spectroscope.core.goal.GoalStore.fileFor(cli.sessionId()));
        } finally {
            restore(previous);
        }
    }
}
