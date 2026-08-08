package dev.spectroscope.server;

import com.fasterxml.jackson.databind.ObjectMapper;
import dev.spectroscope.core.CancelSignal;
import dev.spectroscope.core.config.ProviderFactory;
import dev.spectroscope.core.config.SpectroConfig;
import dev.spectroscope.core.provider.LlmProvider;
import dev.spectroscope.core.provider.LlmProvider.ProviderMessage;
import dev.spectroscope.core.provider.LlmProvider.ProviderRequest;
import dev.spectroscope.core.provider.LlmProvider.PStop;
import dev.spectroscope.core.provider.LlmProvider.PTextDelta;
import dev.spectroscope.core.provider.LlmProvider.TextContent;
import jakarta.servlet.http.HttpServletRequest;

import java.io.IOException;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;
import java.util.List;
import java.util.Map;
import java.util.function.Supplier;

import org.springframework.http.HttpStatus;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.servlet.mvc.method.annotation.StreamingResponseBody;

/**
 * The LLM-backed explain (card 62): the Text tab POSTs a bounded, readable
 * digest of the viewed run (the same feed it renders) and gets back a streamed
 * INTERPRETATION — what the agent was trying to do, why each step followed,
 * where it hesitated, how it recovered. The reply is a model's reading of the
 * RECORDED run, and the UI labels it that way; the deterministic gates panel
 * in the trace tab is untouched (that one folds frames, this one interprets).
 *
 * <p>Wire: NDJSON ({@code application/x-ndjson}) — first {@code {meta:{provider,model}}},
 * then {@code {delta}} lines as the model streams, terminally {@code {done:true}}
 * or {@code {error}}. The client parses line-wise off a fetch reader.</p>
 *
 * <p>Security: this endpoint spends the operator's API key, so it wears BOTH
 * fences the key-write endpoint wears — {@link LocalOrigin#isLocalOrigin}
 * against remote/rebound callers and a loopback-or-absent Origin check against
 * cross-site pages (CSRF). No {@code @CrossOrigin}: a wildcard CORS policy let a
 * foreign page deliver a large JSON body (the digest) that Spring materializes
 * before the fence runs — a needless cross-origin DoS window on a key-spending
 * endpoint. Same-origin only, like the settings and probe controllers.</p>
 */
@RestController
public class ExplainController {

    /** Output budget for one interpretation — an essay is a smell, not a feature. */
    private static final int MAX_TOKENS = 1200;
    /** Hard inbound bound; the client caps its digest well below this. */
    private static final int MAX_DIGEST_CHARS = 200_000;

    /**
     * The same bound one layer out, in bytes, for {@link ApiLocalFence} to
     * enforce on the DECLARED length before Spring materialises the body — the
     * check below can only run once the JSON is already an object in memory.
     * Four bytes per character plus JSON escaping is generous for the widest
     * digest {@link #MAX_DIGEST_CHARS} allows, so nothing honest is refused
     * here and everything dishonest stops before it is read.
     */
    public static final int MAX_BODY_BYTES = 4 * MAX_DIGEST_CHARS;

    /**
     * Seam: build the provider from config (real: {@link ProviderFactory}).
     *
     * <p>Public because {@code GistWriter} holds one as a field and takes one in
     * its constructor, so that both spend the operator's key through a single
     * seam — and {@code GistWriter} now lives in {@code .transcripts}. This is
     * the only declaration the {@code .transcripts} and {@code .observability}
     * moves had to widen.</p>
     */
    public interface ProviderBuilder {
        LlmProvider build(SpectroConfig config);
    }

    private final ProviderBuilder providers;
    private final Supplier<SpectroConfig> configLoader;
    private final ObjectMapper mapper = new ObjectMapper();

    /** Spring wiring: the real factory on the server's own config. */
    public ExplainController() {
        this(ProviderFactory::providerFromConfig,
             () -> SpectroConfig.load(SpectroConfig.Overrides.none()));
    }

    /**
     * Seam for tests: inject the provider build and the config source.
     *
     * @param providers    builds the provider for one call
     * @param configLoader resolves the server's current config
     */
    ExplainController(ProviderBuilder providers, Supplier<SpectroConfig> configLoader) {
        this.providers = providers;
        this.configLoader = configLoader;
    }

    /** The request body: the run digest plus the answer language. */
    public record ExplainBody(String digest, String lang) {}

    /**
     * One interpretation call, streamed as NDJSON.
     *
     * @param body    the digest + language
     * @param request the servlet request, for the two origin fences
     * @return 200 with the NDJSON stream · 400 blank digest · 404 non-local ·
     *         413 oversize · 503 when no provider is ready (readable message)
     */
    @PostMapping(value = "/api/explain", consumes = MediaType.APPLICATION_JSON_VALUE)
    public ResponseEntity<StreamingResponseBody> explain(@RequestBody(required = false) ExplainBody body,
                                                         HttpServletRequest request) {
        if (!LocalOrigin.isLocalOrigin(request) || !LocalOrigin.originIsLoopbackOrAbsent(request)) {
            return ResponseEntity.notFound().build();
        }
        if (body == null || body.digest() == null || body.digest().isBlank()) {
            return ResponseEntity.badRequest().build();
        }
        if (body.digest().length() > MAX_DIGEST_CHARS) {
            return ResponseEntity.status(HttpStatus.PAYLOAD_TOO_LARGE).build();
        }

        SpectroConfig config = configLoader.get();
        LlmProvider provider;
        try {
            provider = providers.build(config);
        } catch (RuntimeException notReady) {
            // The readable path the UI shows verbatim ("set a key in Settings").
            return ResponseEntity.status(HttpStatus.SERVICE_UNAVAILABLE)
                    .contentType(MediaType.APPLICATION_JSON)
                    .body(out -> out.write(json(Map.of("error", String.valueOf(notReady.getMessage())))
                            .getBytes(StandardCharsets.UTF_8)));
        }

        ProviderRequest providerRequest = new ProviderRequest(
                systemPrompt(body.lang()),
                List.of(new ProviderMessage(ProviderMessage.Role.USER,
                        List.of(new TextContent(body.digest())))),
                List.of(),          // a one-shot reading — no tools, no gate
                MAX_TOKENS,
                false,
                new CancelSignal());

        StreamingResponseBody stream = out -> {
            writeLine(out, Map.of("meta", Map.of(
                    "provider", String.valueOf(config.provider()),
                    "model", String.valueOf(config.model()))));
            try {
                for (LlmProvider.ProviderEvent event : provider.stream(providerRequest)) {
                    if (event instanceof PTextDelta delta) {
                        writeLine(out, Map.of("delta", delta.text()));
                    } else if (event instanceof PStop) {
                        break;
                    }
                    // PThinkingDelta / PToolCall / PUsage: not part of the reading
                }
                writeLine(out, Map.of("done", true));
            } catch (IOException clientGone) {
                throw clientGone; // the browser closed the panel — stop writing
            } catch (RuntimeException providerDied) {
                // Mid-stream failure: a readable terminal line, never a stack trace.
                writeLine(out, Map.of("error", String.valueOf(providerDied.getMessage())));
            }
        };
        return ResponseEntity.ok()
                .contentType(MediaType.parseMediaType("application/x-ndjson"))
                .body(stream);
    }

    /** The interpretation instructions — the honesty boundary lives in the prompt too. */
    private static String systemPrompt(String lang) {
        String language = "de".equalsIgnoreCase(lang) ? "German" : "English";
        return """
                You are the explain lens of spectroscope, an agent orchestrator. You get the \
                recorded transcript of one agent session as readable text: prompts, <think> \
                reasoning runs, [tool_call]/[tool_result] markers, permission gates, run \
                boundaries, errors. Multiple agents may interleave; non-main agents are \
                prefixed with their id.

                Interpret WHY the session went the way it did: what the agent was trying to \
                do, why each step followed from what came before, where it hesitated or was \
                gated, where it recovered or failed. Ground every claim in the transcript and \
                name the concrete steps you lean on. You are reading a recording — you do not \
                see the model's hidden state, so never claim internals; where the transcript \
                is ambiguous, say so.

                Shape: a short narrative first (2-4 paragraphs), then at most five bullet \
                points for notable moments (a surprising tool result, a gate, a recovery). \
                Plain prose, no headings. Answer in %s.""".formatted(language);
    }

    /** One NDJSON line + flush, so deltas surface as they stream. */
    private void writeLine(OutputStream out, Map<String, Object> message) throws IOException {
        out.write((json(message) + "\n").getBytes(StandardCharsets.UTF_8));
        out.flush();
    }

    private String json(Map<String, Object> message) {
        try {
            return mapper.writeValueAsString(message);
        } catch (IOException impossible) {
            return "{\"error\":\"encoding failed\"}";
        }
    }

}
