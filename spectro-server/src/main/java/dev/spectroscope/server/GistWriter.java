package dev.spectroscope.server;

import dev.spectroscope.core.CancelSignal;
import dev.spectroscope.core.config.ProviderFactory;
import dev.spectroscope.core.config.SpectroConfig;
import dev.spectroscope.core.provider.LlmProvider;
import dev.spectroscope.core.provider.LlmProvider.PTextDelta;
import dev.spectroscope.core.provider.LlmProvider.ProviderMessage;
import dev.spectroscope.core.provider.LlmProvider.ProviderRequest;
import dev.spectroscope.core.provider.LlmProvider.TextContent;

import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.function.Function;
import java.util.function.Supplier;

/**
 * Asks the configured model what a transcript was about, one line each.
 *
 * <p>The same seam {@code ExplainController} uses — the operator's configured
 * provider, one bounded request, no tools and no gate — with a different
 * instruction, because a gist is not an interpretation. Explain reads a run and
 * says why each step followed; this says what the session was FOR, so a reader
 * scanning three hundred rows can find the one he means.</p>
 *
 * <p><b>Serial, deliberately.</b> Three hundred concurrent requests to a paid
 * endpoint is a way to hit a rate limit and a bill at the same time. The button
 * is pressed by a person who is watching, and the dialog reports what landed.</p>
 *
 * <p><b>Bounded input.</b> Only the opening prompt travels, capped. A whole
 * transcript is megabytes and the answer would not improve — what a session was
 * about is in the first thing somebody asked for, and where it is not, a gist is
 * the wrong tool.</p>
 */
final class GistWriter {

    /** A gist is one line. A model given room writes an essay, so it is not given room. */
    private static final int MAX_TOKENS = 120;
    /** How much of the opening prompt travels. Measured over the store: the
     *  median first prompt is under 300 characters and the long tail is pasted
     *  logs, which say nothing more about the session's purpose than its head. */
    static final int MAX_PROMPT_CHARS = 1200;
    /** A ceiling on one press, so a slip cannot spend an afternoon of quota. */
    static final int MAX_PER_PRESS = 60;

    private final Supplier<SpectroConfig> configLoader;
    /** The same seam ExplainController uses, so both spend the key one way. */
    private final ExplainController.ProviderBuilder providers;

    GistWriter() {
        this(() -> SpectroConfig.load(SpectroConfig.Overrides.none()), ProviderFactory::providerFromConfig);
    }

    GistWriter(Supplier<SpectroConfig> configLoader, ExplainController.ProviderBuilder providers) {
        this.configLoader = configLoader;
        this.providers = providers;
    }

    /** The instruction. The honesty boundary lives in the prompt: a model that
     *  cannot tell is told to say so rather than to invent a plausible subject. */
    private static String systemPrompt() {
        return """
                You are given the opening prompt of a recorded agent session. Reply with ONE line, \
                at most 12 words, naming what the session was FOR — the task, not the tone. No \
                preamble, no quotes, no trailing period. Write it in English. If the prompt does \
                not say what the work was, reply exactly: unclear from the opening prompt.""";
    }

    /**
     * Writes the gists that are missing, and returns every gist the caller asked
     * about — stored or freshly written.
     *
     * @param paths the store-relative transcripts the dialog is showing
     * @param store where gists live
     * @param resolve turns a store-relative path into a real file, or null
     * @return the rows, how many were written, and a readable error when the
     *         provider would not build at all
     */
    ClaudeTranscriptsController.GistsResponse write(
            List<String> paths,
            TranscriptGists store,
            Function<String, Path> resolve) {
        List<ClaudeTranscriptsController.GistRow> rows = new ArrayList<>();
        List<String> todo = new ArrayList<>();
        for (String path : paths) {
            Path file = resolve.apply(path);
            if (file == null) {
                continue; // not a transcript in the store; the reader says nothing
            }
            String stamp = TranscriptGists.stampOf(file);
            TranscriptGists.Gist have = store.current(path, stamp);
            if (have != null) {
                rows.add(new ClaudeTranscriptsController.GistRow(path, have.text(), have.model(), false));
            } else {
                todo.add(path);
            }
        }
        if (todo.isEmpty()) {
            return new ClaudeTranscriptsController.GistsResponse(List.copyOf(rows), 0, null);
        }

        SpectroConfig config = configLoader.get();
        LlmProvider provider;
        try {
            provider = providers.build(config);
        } catch (RuntimeException notReady) {
            // The readable path the UI shows verbatim, the same one explain uses.
            return new ClaudeTranscriptsController.GistsResponse(
                    List.copyOf(rows), 0, String.valueOf(notReady.getMessage()));
        }
        String model = String.valueOf(config.model());

        int written = 0;
        for (String path : todo) {
            if (written >= MAX_PER_PRESS) {
                break; // the rest stay missing, and the next press takes them
            }
            Path file = resolve.apply(path);
            if (file == null) {
                continue;
            }
            String prompt = TranscriptFacts.fold(file).firstPrompt();
            if (prompt == null || prompt.isBlank()) {
                continue; // nothing to read: no gist, and no invented one either
            }
            String line = ask(provider, prompt);
            if (line == null) {
                continue; // one failure does not abandon the rest of the press
            }
            TranscriptGists.Gist gist = new TranscriptGists.Gist(
                    line, model, TranscriptGists.stampOf(file), System.currentTimeMillis());
            store.put(path, gist);
            rows.add(new ClaudeTranscriptsController.GistRow(path, line, model, false));
            written++;
        }
        return new ClaudeTranscriptsController.GistsResponse(List.copyOf(rows), written, null);
    }

    /**
     * One line out of the model, or null when it did not answer.
     *
     * @param provider the built provider
     * @param prompt the transcript's opening prompt
     * @return the gist, trimmed to one line, or null
     */
    private static String ask(LlmProvider provider, String prompt) {
        String head = prompt.length() > MAX_PROMPT_CHARS ? prompt.substring(0, MAX_PROMPT_CHARS) : prompt;
        ProviderRequest request = new ProviderRequest(
                systemPrompt(),
                List.of(new ProviderMessage(ProviderMessage.Role.USER, List.of(new TextContent(head)))),
                List.of(),
                MAX_TOKENS,
                false,
                new CancelSignal());
        StringBuilder text = new StringBuilder();
        try {
            for (LlmProvider.ProviderEvent event : provider.stream(request)) {
                if (event instanceof PTextDelta delta) {
                    text.append(delta.text());
                }
            }
        } catch (RuntimeException failed) {
            return null;
        }
        // One line, whatever the model did with the instruction. A reasoning
        // model that ignores "no preamble" must not turn a row into a paragraph.
        String line = text.toString().strip();
        int br = line.indexOf('\n');
        if (br >= 0) {
            line = line.substring(0, br).strip();
        }
        return line.isEmpty() ? null : line;
    }
}
