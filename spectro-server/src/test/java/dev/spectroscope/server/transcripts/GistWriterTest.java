package dev.spectroscope.server.transcripts;

import dev.spectroscope.core.CancelSignal;
import dev.spectroscope.core.config.SpectroConfig;
import dev.spectroscope.core.provider.LlmProvider;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.atomic.AtomicInteger;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * Card 179 stage 3: one model-written line per transcript, paid for once.
 *
 * <p>The whole value is in NOT asking twice. A gist costs an API call, so the
 * button must do the new ones and leave the rest alone, and the answers must
 * survive a restart or the button is a tax the operator pays every time he opens
 * the dialog.</p>
 */
class GistWriterTest {

    @TempDir
    Path store;

    /** A provider that answers a fixed line and counts how often it was asked. */
    private static final class Counting implements LlmProvider {
        final AtomicInteger asked = new AtomicInteger();
        private final String answer;

        Counting(String answer) {
            this.answer = answer;
        }

        @Override
        public Iterable<ProviderEvent> stream(ProviderRequest request) {
            asked.incrementAndGet();
            List<ProviderEvent> out = new ArrayList<>();
            out.add(new PTextDelta(answer));
            return out;
        }
    }

    private Path transcript(String name, String prompt) throws Exception {
        Path p = store.resolve(name);
        Files.writeString(p, "{\"type\":\"user\",\"message\":{\"role\":\"user\",\"content\":\""
                + prompt + "\"}}\n");
        return p;
    }

    private GistWriter writerWith(LlmProvider provider) {
        return new GistWriter(() -> SpectroConfig.load(SpectroConfig.Overrides.none()), config -> provider);
    }

    @Test
    void writesOneLinePerTranscriptAndStoresIt() throws Exception {
        transcript("a.jsonl", "build the poster");
        TranscriptGists gists = new TranscriptGists(store.resolve("gists.json"));
        Counting provider = new Counting("build a deterministic poster generator");

        var res = writerWith(provider).write(List.of("a.jsonl"), gists, store::resolve);

        assertEquals(1, res.written());
        assertEquals(1, provider.asked.get());
        assertEquals("build a deterministic poster generator", res.gists().get(0).text());
        assertNotNull(gists.current("a.jsonl", TranscriptGists.stampOf(store.resolve("a.jsonl"))));
    }

    @Test
    void theSecondPressAsksOnlyAboutTheNewOnes() throws Exception {
        transcript("a.jsonl", "build the poster");
        TranscriptGists gists = new TranscriptGists(store.resolve("gists.json"));
        Counting provider = new Counting("a line");
        GistWriter writer = writerWith(provider);

        writer.write(List.of("a.jsonl"), gists, store::resolve);
        transcript("b.jsonl", "review the diff");
        var res = writer.write(List.of("a.jsonl", "b.jsonl"), gists, store::resolve);

        // Two rows come back, but only ONE of them cost anything.
        assertEquals(2, res.gists().size());
        assertEquals(1, res.written());
        assertEquals(2, provider.asked.get());
    }

    @Test
    void aTranscriptThatGrewIsGistedAgain() throws Exception {
        // Live sessions grow constantly, and they are the rows an operator looks
        // at most. A gist written for yesterday's file is about a shorter run.
        Path a = transcript("a.jsonl", "build the poster");
        TranscriptGists gists = new TranscriptGists(store.resolve("gists.json"));
        Counting provider = new Counting("a line");
        GistWriter writer = writerWith(provider);
        writer.write(List.of("a.jsonl"), gists, store::resolve);

        Files.writeString(a, Files.readString(a) + "{\"type\":\"user\",\"message\":{\"content\":\"more\"}}\n");
        var res = writer.write(List.of("a.jsonl"), gists, store::resolve);

        assertEquals(1, res.written());
        assertEquals(2, provider.asked.get());
    }

    @Test
    void theStoreSurvivesAProcessThatEnded() throws Exception {
        transcript("a.jsonl", "build the poster");
        Path file = store.resolve("gists.json");
        Counting provider = new Counting("a line");
        writerWith(provider).write(List.of("a.jsonl"), new TranscriptGists(file), store::resolve);

        // A brand-new store object, which is what the next boot has.
        var res = writerWith(provider).write(List.of("a.jsonl"), new TranscriptGists(file), store::resolve);

        assertEquals(0, res.written());
        assertEquals(1, provider.asked.get(), "the second process must not pay again");
        assertEquals("a line", res.gists().get(0).text());
    }

    @Test
    void aProviderThatWillNotBuildSaysSoAndSpendsNothing() throws Exception {
        transcript("a.jsonl", "build the poster");
        TranscriptGists gists = new TranscriptGists(store.resolve("gists.json"));

        var res = new GistWriter(
                () -> SpectroConfig.load(SpectroConfig.Overrides.none()),
                config -> {
                    throw new IllegalStateException("set a key in Settings");
                }).write(List.of("a.jsonl"), gists, store::resolve);

        assertEquals("set a key in Settings", res.error());
        assertEquals(0, res.written());
        assertTrue(res.gists().isEmpty());
    }

    @Test
    void aTranscriptWithNoOpeningPromptGetsNoInventedOne() throws Exception {
        Path p = store.resolve("empty.jsonl");
        Files.writeString(p, "{\"type\":\"assistant\",\"message\":{\"content\":[]}}\n");
        TranscriptGists gists = new TranscriptGists(store.resolve("gists.json"));
        Counting provider = new Counting("something plausible");

        var res = writerWith(provider).write(List.of("empty.jsonl"), gists, store::resolve);

        assertEquals(0, res.written());
        assertEquals(0, provider.asked.get());
        assertTrue(res.gists().isEmpty());
    }

    @Test
    void aPathOutsideTheStoreIsSimplySkipped() throws Exception {
        TranscriptGists gists = new TranscriptGists(store.resolve("gists.json"));
        Counting provider = new Counting("a line");

        var res = writerWith(provider).write(List.of("nope.jsonl"), gists, path -> null);

        assertEquals(0, provider.asked.get());
        assertTrue(res.gists().isEmpty());
    }

    @Test
    void doingThemAllAgainForgetsWhatWasThere() throws Exception {
        transcript("a.jsonl", "build the poster");
        Path file = store.resolve("gists.json");
        TranscriptGists gists = new TranscriptGists(file);
        writerWith(new Counting("old model's line")).write(List.of("a.jsonl"), gists, store::resolve);

        // What the "all" button does before it re-runs: a half-finished re-run
        // must not leave two models' sentences beside each other.
        gists.clear();
        assertNull(gists.current("a.jsonl", TranscriptGists.stampOf(store.resolve("a.jsonl"))));

        Counting fresh = new Counting("new model's line");
        var res = writerWith(fresh).write(List.of("a.jsonl"), gists, store::resolve);
        assertEquals(1, fresh.asked.get());
        assertEquals("new model's line", res.gists().get(0).text());
    }

    @Test
    void onlyTheFirstLineOfAChattyAnswerBecomesTheGist() throws Exception {
        transcript("a.jsonl", "build the poster");
        TranscriptGists gists = new TranscriptGists(store.resolve("gists.json"));

        var res = writerWith(new Counting("  a poster generator\n\nHere is why: blah blah  "))
                .write(List.of("a.jsonl"), gists, store::resolve);

        assertEquals("a poster generator", res.gists().get(0).text());
    }
}
