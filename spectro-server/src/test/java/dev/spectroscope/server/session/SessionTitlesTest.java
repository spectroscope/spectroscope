package dev.spectroscope.server.session;

import dev.spectroscope.core.events.RunEvent;
import dev.spectroscope.core.provider.LlmProvider;
import dev.spectroscope.core.provider.LlmProvider.PStop;
import dev.spectroscope.core.provider.LlmProvider.PTextDelta;
import dev.spectroscope.core.provider.LlmProvider.PThinkingDelta;
import dev.spectroscope.core.provider.LlmProvider.ProviderMessage;
import dev.spectroscope.core.provider.LlmProvider.ProviderRequest;
import dev.spectroscope.core.provider.LlmProvider.TextContent;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.Timeout;
import org.junit.jupiter.api.io.TempDir;

import java.nio.file.Path;
import java.time.Duration;
import java.util.List;
import java.util.Optional;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicReference;
import java.util.function.Supplier;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * Card 445, criteria 6 and 7: a new session's title comes from its first
 * prompt, through one small request to the session's own model.
 *
 * <p>The provider here is scripted. What is pinned is the request's shape and
 * what happens to the answer, never the words a live model chooses.</p>
 */
@Timeout(value = 60, unit = TimeUnit.SECONDS, threadMode = Timeout.ThreadMode.SEPARATE_THREAD)
class SessionTitlesTest {

    /**
     * The owner's first prompt from picture 3 of the card
     * ({@code kanban/evidence/445/owner-example-3-first-prompt.png}), the part the
     * picture shows. Claude titled it "Subagenten und Workflows Review".
     */
    static final String OWNERS_PROMPT = "lese die CLAUDE.md und schaue dir die offenen tickets und next"
            + " session an und auch die worktrees und was passiert. mache mit workflows alles soweit"
            + " fertig was gerade in arbeit ist und reviewe die arbeit von glm und minimax von gestern"
            + " die ich mit spectroscope selber gebaut habe und was irgendwie schiefgegangen ist, da ist"
            + " was mit den Subagenten komplett schiefgegangen und wie gesagt, die ganzen Turns passen"
            + " nicht, das steht ja alles schon in den Tickets, aber ich habe es gestern nochmal"
            + " ausprobiert und auch die Subagentenverwaltung ist nicht so geil. Zumindest bei Minimax"
            + " ging es, aber bei GLM 5.3 ging der Stop-Button nicht. Ich weiß nicht warum. Und GLM hat"
            + " da gestern so ein paar Sachen gebaut oder Minimax. Guck dir mal die Session an. Ich habe"
            + " dir die Jason L. hingelegt. Die haben auch irgendeine App released, aber irgendwie in"
            + " einem falschen Zustand und alles. Es war alles ziemlich schrecklich. Und bitte, bitte"
            + " guck dir das mal an und dreh es, wenn es sinn- wenn es sinnlos ist, bitte zurück.";

    @TempDir
    Path home;

    private SessionMetaStore store() {
        return new SessionMetaStore(home.resolve("session-meta.json"));
    }

    /** Answers a fixed text as a stream of deltas and keeps the request it was asked. */
    private static final class Scripted implements LlmProvider {
        final AtomicReference<ProviderRequest> asked = new AtomicReference<>();
        final AtomicInteger calls = new AtomicInteger();
        private final List<ProviderEvent> answer;

        Scripted(ProviderEvent... answer) {
            this.answer = List.of(answer);
        }

        static Scripted saying(String text) {
            return new Scripted(new PTextDelta(text), new PStop(PStop.StopReason.END_TURN));
        }

        @Override
        public Iterable<ProviderEvent> stream(ProviderRequest request) {
            asked.set(request);
            calls.incrementAndGet();
            return answer;
        }
    }

    private static Supplier<LlmProvider> of(LlmProvider provider) {
        return () -> provider;
    }

    @Test
    void theRequestCarriesTheFirstPromptOnlyAndAShortInstruction() {
        Scripted model = Scripted.saying("Subagenten und Workflows Review");
        new SessionTitles(store(), SessionTitles.TIME_LIMIT).suggestNow("s1", OWNERS_PROMPT, of(model));

        ProviderRequest request = model.asked.get();
        assertThat(request).as("the model was asked").isNotNull();
        assertThat(request.messages()).as("the first prompt and nothing else").hasSize(1);
        ProviderMessage only = request.messages().getFirst();
        assertThat(only.role()).isEqualTo(ProviderMessage.Role.USER);
        assertThat(only.content()).containsExactly(new TextContent(OWNERS_PROMPT));
        assertThat(request.tools()).as("a title is not an agent turn").isEmpty();

        assertThat(request.system())
                .as("a short instruction asking for a three to five word title")
                .contains("three to five words")
                .contains("language of the message")
                .hasSizeLessThan(600);
        assertThat(request.reasoning()).as("thinking off").isEqualTo(ProviderRequest.Reasoning.OFF);
        assertThat(request.effort()).isNull();
        assertThat(request.maxTokens())
                .as("a small output cap")
                .isEqualTo(SessionTitles.MAX_OUTPUT_TOKENS)
                .isBetween(16, 256);
    }

    @Test
    void aLongFirstPromptIsCutAtTheNamedLength() {
        Scripted model = Scripted.saying("Pasted log review");
        String longPrompt = "x".repeat(SessionTitles.MAX_PROMPT_CHARS * 3);
        new SessionTitles(store(), SessionTitles.TIME_LIMIT).suggestNow("s1", longPrompt, of(model));

        TextContent sent = (TextContent) model.asked.get().messages().getFirst().content().getFirst();
        assertThat(sent.text()).hasSize(SessionTitles.MAX_PROMPT_CHARS);
        assertThat(longPrompt).startsWith(sent.text());
    }

    @Test
    void theOwnersExampleEndsUpAsASuggestedTitle() {
        // A realistic answer: German quotes and a full stop the instruction asked
        // the model to leave out.
        Scripted model = Scripted.saying("„Subagenten und Workflows Review“.");
        Optional<SessionMetaStore.Entry> entry =
                new SessionTitles(store(), SessionTitles.TIME_LIMIT).suggestNow("s1", OWNERS_PROMPT, of(model));

        assertThat(entry).isPresent();
        assertThat(store().get("s1").orElseThrow().title()).isEqualTo("Subagenten und Workflows Review");
        assertThat(store().get("s1").orElseThrow().titleSource()).isEqualTo(SessionMetaStore.SUGGESTED);
    }

    @Test
    void theAnswerIsCleanedToOneLineWithoutQuotesOrATrailingFullStop() {
        assertThat(SessionTitles.clean("\"Release notes summary\"")).isEqualTo("Release notes summary");
        assertThat(SessionTitles.clean("'Release notes summary'.")).isEqualTo("Release notes summary");
        assertThat(SessionTitles.clean("«Release notes summary»")).isEqualTo("Release notes summary");
        assertThat(SessionTitles.clean("Release notes summary...")).isEqualTo("Release notes summary");
        assertThat(SessionTitles.clean("\n\nRelease notes summary\nThis title says what the session"
                + " is about.")).isEqualTo("Release notes summary");
        assertThat(SessionTitles.clean("Title: Release notes summary")).isEqualTo("Release notes summary");
        assertThat(SessionTitles.clean("Titel: Release-Notes zusammenfassen")).isEqualTo("Release-Notes zusammenfassen");
        assertThat(SessionTitles.clean("**Release notes summary**")).isEqualTo("Release notes summary");
        assertThat(SessionTitles.clean("# Release notes summary")).isEqualTo("Release notes summary");
        assertThat(SessionTitles.clean("<think>the user wants</think>Release notes summary"))
                .isEqualTo("Release notes summary");
        assertThat(SessionTitles.clean("v0.14.0 release")).as("a dot inside stays").isEqualTo("v0.14.0 release");
    }

    @Test
    void anAnswerWithNothingUsableInItCleansToNothing() {
        assertThat(SessionTitles.clean(null)).isEmpty();
        assertThat(SessionTitles.clean("   \n  ")).isEmpty();
        assertThat(SessionTitles.clean("\"\".")).isEmpty();
        assertThat(SessionTitles.clean("<think>only thinking</think>")).isEmpty();
    }

    @Test
    void aLongAnswerIsCutAtTheNamedLength() {
        String answer = "word ".repeat(60);
        assertThat(SessionTitles.clean(answer).length()).isLessThanOrEqualTo(SessionMetaStore.TITLE_MAX_CHARS);
    }

    @Test
    void thinkingDeltasAreNotTheTitle() {
        Scripted model = new Scripted(new PThinkingDelta("the user is asking about"),
                new PTextDelta("Release notes summary"), new PStop(PStop.StopReason.END_TURN));
        new SessionTitles(store(), SessionTitles.TIME_LIMIT).suggestNow("s1", "summarise the release notes", of(model));

        assertThat(store().get("s1").orElseThrow().title()).isEqualTo("Release notes summary");
    }

    @Test
    void aFailingModelLeavesTheRowOnItsFirstPrompt() {
        LlmProvider failing = request -> {
            throw new IllegalStateException("backend refused the connection");
        };
        assertThat(new SessionTitles(store(), SessionTitles.TIME_LIMIT)
                .suggestNow("s1", OWNERS_PROMPT, of(failing))).isEmpty();
        assertThat(store().get("s1")).as("no title, so the row shows the first prompt").isEmpty();
    }

    @Test
    void aModelThatCannotBeBuiltLeavesTheRowOnItsFirstPrompt() {
        Supplier<LlmProvider> missingKey = () -> {
            throw new IllegalStateException("ANTHROPIC_API_KEY is not set");
        };
        assertThat(new SessionTitles(store(), SessionTitles.TIME_LIMIT)
                .suggestNow("s1", OWNERS_PROMPT, missingKey)).isEmpty();
        assertThat(store().get("s1")).isEmpty();
    }

    @Test
    void anEmptyAnswerLeavesTheRowOnItsFirstPrompt() {
        Scripted model = Scripted.saying("   ");
        new SessionTitles(store(), SessionTitles.TIME_LIMIT).suggestNow("s1", OWNERS_PROMPT, of(model));
        assertThat(store().get("s1")).isEmpty();
    }

    @Test
    void aSlowModelIsCutOffAtTheTimeLimitAndItsStreamCancelled() {
        AtomicReference<ProviderRequest> asked = new AtomicReference<>();
        LlmProvider hanging = request -> {
            asked.set(request);
            return () -> {
                long until = System.nanoTime() + TimeUnit.SECONDS.toNanos(20);
                while (!request.signal().isCancelled() && System.nanoTime() < until) {
                    Thread.onSpinWait();
                }
                return List.<LlmProvider.ProviderEvent>of(new PTextDelta("too late")).iterator();
            };
        };
        long start = System.nanoTime();
        Optional<SessionMetaStore.Entry> entry =
                new SessionTitles(store(), Duration.ofMillis(300)).suggestNow("s1", OWNERS_PROMPT, of(hanging));
        long took = TimeUnit.NANOSECONDS.toMillis(System.nanoTime() - start);

        assertThat(entry).isEmpty();
        assertThat(took).as("the caller waits the time limit, not the model").isLessThan(5_000);
        assertThat(asked.get().signal().isCancelled()).as("the request itself is cancelled").isTrue();
        assertThat(store().get("s1")).isEmpty();
    }

    @Test
    void theBackgroundRequestReturnsAtOnceAndStoresTheTitleLater() throws Exception {
        CountDownLatch release = new CountDownLatch(1);
        LlmProvider waiting = request -> {
            try {
                release.await(20, TimeUnit.SECONDS);
            } catch (InterruptedException interrupted) {
                Thread.currentThread().interrupt();
            }
            return List.of(new PTextDelta("Release notes summary"), new PStop(PStop.StopReason.END_TURN));
        };
        SessionTitles titles = new SessionTitles(store(), SessionTitles.TIME_LIMIT);

        long start = System.nanoTime();
        Thread background = titles.suggestInBackground("s1", "summarise the release notes", of(waiting));
        long took = TimeUnit.NANOSECONDS.toMillis(System.nanoTime() - start);

        assertThat(took).as("starting the request costs the run nothing").isLessThan(1_000);
        assertThat(store().get("s1")).as("the model has not answered yet").isEmpty();

        release.countDown();
        background.join(10_000);
        assertThat(store().get("s1").orElseThrow().title()).isEqualTo("Release notes summary");
    }

    @Test
    void aSessionTheOperatorAlreadyNamedIsNotAskedAbout() {
        SessionMetaStore store = store();
        store.rename("s1", "Release 0.14.0");
        Scripted model = Scripted.saying("Something else");

        new SessionTitles(store, SessionTitles.TIME_LIMIT).suggestNow("s1", OWNERS_PROMPT, of(model));

        assertThat(model.calls.get()).isZero();
        assertThat(store().get("s1").orElseThrow().title()).isEqualTo("Release 0.14.0");
    }

    @Test
    void aBlankFirstPromptAsksNothing() {
        Scripted model = Scripted.saying("Something");
        new SessionTitles(store(), SessionTitles.TIME_LIMIT).suggestNow("s1", "  ", of(model));
        assertThat(model.calls.get()).isZero();
        assertThat(store().get("s1")).isEmpty();
    }

    // ---- card 496, final round: the title call's AI credits count for the session ----

    @Test
    void theTitleCallsUsageReachesTheListenerWithItsCredits() {
        Scripted model = new Scripted(new PTextDelta("Release notes"),
                new LlmProvider.PUsage(120, 6, 0, 0, 0.0412), new PStop(PStop.StopReason.END_TURN));
        List<LlmProvider.PUsage> heard = new java.util.concurrent.CopyOnWriteArrayList<>();

        new SessionTitles(store(), SessionTitles.TIME_LIMIT).suggestNow("s1", "summarise the release notes",
                of(model), heard::add);

        assertThat(heard).containsExactly(new LlmProvider.PUsage(120, 6, 0, 0, 0.0412));
        assertThat(store().get("s1").orElseThrow().title()).isEqualTo("Release notes");
    }

    @Test
    void aTitleCallWithCreditsBecomesAUsageEventOfTheTitleAgent() {
        RunEvent.Usage event = SessionConnection.titleUsageEvent(new LlmProvider.PUsage(120, 6, 3, 4, 0.0412), 77L)
                .orElseThrow();

        assertThat(event.agentId()).isEqualTo(SessionConnection.TITLE_AGENT_ID);
        assertThat(event.agentId()).isNotEqualTo("main");
        assertThat(event.aiCredits()).isEqualTo(0.0412);
        assertThat(event.inputTokens()).isEqualTo(120);
        assertThat(event.outputTokens()).isEqualTo(6);
        assertThat(event.cacheReadTokens()).isEqualTo(3);
        assertThat(event.cacheCreationTokens()).isEqualTo(4);
        assertThat(event.ts()).isEqualTo(77L);
    }

    @Test
    void aTitleCallWithoutCreditsAddsNoEvent() {
        assertThat(SessionConnection.titleUsageEvent(new LlmProvider.PUsage(120, 6, 0, 0), 77L)).isEmpty();
    }

    @Test
    void theSessionHandsTheTitleCallsUsageToItsOwnRecord() throws Exception {
        String source = java.nio.file.Files.readString(Path.of(
                "src/main/java/dev/spectroscope/server/session/SessionConnection.java"));
        assertThat(source).contains("titles.suggestInBackground(store.id(), prompt, () -> ServerProviders.build(config),"
                + "\n                usage -> titleUsageEvent(usage, System.currentTimeMillis()).ifPresent(this::recordAndMirror));");
    }
}
