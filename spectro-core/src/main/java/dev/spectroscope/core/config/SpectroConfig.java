package dev.spectroscope.core.config;

import com.fasterxml.jackson.annotation.JsonIgnoreProperties;
import com.fasterxml.jackson.annotation.JsonInclude;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import dev.spectroscope.core.config.governing.Governs;
import dev.spectroscope.core.mcp.McpServerConfig;
import dev.spectroscope.core.provider.AnthropicProvider;
import dev.spectroscope.core.provider.LlmProvider;
import dev.spectroscope.core.provider.OllamaOptions;
import dev.spectroscope.core.provider.OllamaProvider;
import dev.spectroscope.core.provider.OpenAiCompatProvider;
import dev.spectroscope.core.provider.RetryPolicy;
import dev.spectroscope.core.provider.RetryingProvider;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.attribute.PosixFilePermissions;
import java.nio.file.StandardOpenOption;
import java.util.ArrayList;
import java.util.Collections;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.Set;
import java.util.function.Function;

/**
 * The spectroscope configuration with the full settings hierarchy (Claude-Code style):
 *
 * <pre>defaults &lt; env (SPECTRO_*) &lt; ~/.spectro/settings.json (config.json compat)
 * &lt; &lt;project&gt;/.spectro/settings.json &lt; &lt;workspace&gt;/.spectro/settings.json
 * &lt; &lt;workspace&gt;/.spectro/settings.local.json &lt; CLI flags</pre>
 *
 * The environment (typically fed from a gitignored {@code ./.env}) is the
 * BASE just above the defaults — settings files call the shots from there:
 * the per-project (launch-dir) file carries team conventions into the repo
 * (checked in), the user file holds personal defaults, and — joined at the
 * session moment once a workspace resolves, see {@link #loadForWorkspace} —
 * the workspace's own pair speaks loudest of all short of a flag: its
 * project half is meant to be portable and shared, its local half
 * (gitignored by convention) machine-specific. All fields are optional at
 * every layer; missing fields fall through to the layer below.
 *
 * @param provider            the LLM backend — any member of {@link #KNOWN_PROVIDERS}
 * @param model               model id for the chosen provider
 * @param baseUrl             base URL for ollama/openai (ignored for anthropic)
 * @param compactionThreshold input-token threshold that triggers compaction, or
 *                            {@code null} when nobody set one — then the harness
 *                            DERIVES it from the window the backend says it
 *                            loaded, else from the model's published window
 *                            (card 263, card 366,
 *                            {@link dev.spectroscope.core.session.CompactionThreshold}).
 *                            The default used to be a literal 100,000 here, and
 *                            that is the whole reason a session on a 204,288-token
 *                            model summarized itself away at 100,000: with an int
 *                            there was no way to tell "the operator typed this"
 *                            from "nobody said anything".
 * @param permissionMode      "ask", "auto" or "readonly"
 * @param autoApprove         permission allowlist in card 199's grammar,
 *                            {@code <tool>[#<tier>][:<valuePrefix>]} — e.g.
 *                            ["write_file#write", "run_command#eval-execute:git status*"].
 *                            An entry that names no tier approves READ and nothing above,
 *                            and a wildcard that names no tier approves nothing at all
 * @param imageProvider       "gemini" or "openai" — the backend of the generate_image tool
 * @param thinking            surface the model's reasoning stream (default true)
 * @param mcpServers          external MCP servers to connect to; never null,
 *                            defaults to an empty list. The JSON is an object keyed by
 *                            server name; each entry becomes an {@link McpServerConfig}
 *                            with {@code name} taken from the key. A higher-precedence
 *                            layer that defines {@code mcpServers} replaces the whole
 *                            block below it (no deep per-server merge).
 * @param maxRetries          transient-failure retries per provider call (0 disables;
 *                            the wrap happens once in {@link #providerFromConfig()})
 * @param promptCaching       Anthropic prompt caching (cache_control breakpoints);
 *                            a no-op for ollama/openai
 * @param hooks               external shell hooks around tool calls (pre_tool_use /
 *                            post_tool_use); never null. A higher layer that defines
 *                            {@code hooks} replaces the whole block below it —
 *                            whole-block merge, exactly like {@code mcpServers}.
 * @param workspace           the agent's working directory (file tools,
 *                            glob/grep, run_command); {@code null} means a
 *                            per-session folder under the OS temp dir — see
 *                            {@link WorkspaceResolver}
 * @param logLevel            operator-log detail for the file appender
 *                            (error | warn | info | debug | trace, default
 *                            info; env {@code SPECTRO_LOG_LEVEL} wins) — the
 *                            never touches the RunEvent wire
 * @param imageModel          override for the image backend's default model
 *                           ; {@code null} means "use the backend's
 *                            own default" — env {@code SPECTRO_IMAGE_MODEL}
 * @param sttProvider         which way speech to text goes: {@code auto} (the
 *                            hosted API when a key is there, whisper otherwise),
 *                            {@code local}, or {@code openai} — env
 *                            {@code SPECTRO_STT_PROVIDER}
 * @param sttModel            path to the local whisper.cpp model file;
 *                            {@code null} means the CLI-side default —
 *                            env {@code SPECTRO_STT_MODEL}
 * @param sttLanguage         the language dictation is transcribed in:
 *                            {@code auto} (the model detects), {@code de} or
 *                            {@code en} — env {@code SPECTRO_STT_LANGUAGE}
 * @param otlpEndpoint        OTLP traces endpoint (e.g. a local Langfuse's
 *                            {@code http://localhost:3000/api/public/otel});
 *                            null keeps the exporter off. Env
 *                            {@code SPECTRO_OTLP_ENDPOINT}, with
 *                            {@code ~/.spectro/.env} underneath it
 * @param otlpBasicAuth       optional {@code pk:sk} pair sent as Basic auth
 *                            (Langfuse project keys); null sends no auth
 *                            header. Env {@code SPECTRO_OTLP_BASIC_AUTH}, with
 *                            {@code ~/.spectro/.env} underneath it. A
 *                            credential belongs in that 0600 file, not in a
 *                            settings document
 * @param chromeBinary        override for the system-Chrome binary used by
 *                            {@code browse_page}; {@code null} means the
 *                            built-in discovery — env {@code SPECTRO_CHROME}
 * @param ollamaBaseUrl       ollama's OWN address (card 193); {@code null}/blank
 *                            falls back to the legacy shared {@code baseUrl},
 *                            then ollama's preset. Unlike the legacy field, a
 *                            value equal to some provider's default is still a
 *                            value — only null/blank means unset. Env
 *                            {@code SPECTRO_OLLAMA_BASE_URL}
 * @param lmstudioBaseUrl     LM Studio's OWN address (card 193); {@code null}/
 *                            blank falls back to the legacy openai-compat rule
 *                            over {@code baseUrl} (see
 *                            {@link #effectiveOpenAiBaseUrl}). Env
 *                            {@code SPECTRO_LMSTUDIO_BASE_URL}
 * @param searxngUrl          the root URL of a SearXNG instance the USER runs
 *                            (card 203); {@code null}/blank means no instance,
 *                            and web_search then falls to a keyed provider or,
 *                            with nothing configured at all, to the best-effort
 *                            DuckDuckGo scrape. An address, not a credential,
 *                            so it belongs in the settings document. Env
 *                            {@code SPECTRO_SEARXNG_URL}
 * @param allowLocalhost      card 199's net-fence opt-in: browser-class tools
 *                            ({@code web_fetch}, {@code browse_page}) refuse
 *                            loopback by default, and this is the deliberate
 *                            gesture that reaches it for the local verify loop.
 *                            It never widens to RFC-1918, to the 100.64/10
 *                            tailnet or to a {@code file://} URL — not on the
 *                            address the model names and not on a redirect
 *                            either, because {@code web_fetch} fences every hop
 *                            of the chain it walks. What it does NOT reach is
 *                            what Chrome does after {@code browse_page} hands it
 *                            a page: redirects and script navigation from there
 *                            on are the browser's, and unfenced. Process-global
 *                            (a workspace scope may not set it — that folder is
 *                            the agent's own). Env
 *                            {@code SPECTRO_ALLOW_LOCALHOST}
 * @param headlessMcp         card 220's settings-level opt-in (default false):
 *                            when true, every HEADLESS face — {@code spectro
 *                            run}, a cron fire, a triggered fleet node — mounts
 *                            the configured {@code mcpServers} the way the REPL
 *                            does. A manual {@code spectro run} may override it
 *                            per invocation with {@code --mcp} / {@code
 *                            --no-mcp}; absent flags, this field decides. Under
 *                            {@code --permissions auto} the opt-in approves
 *                            every tool every configured server offers,
 *                            unwatched — which is why it is a consent switch
 *                            and not a convenience. Process-global (a workspace
 *                            scope may not set it — the switch that widens an
 *                            unattended run must not live in the folder the
 *                            agent writes into). Env {@code SPECTRO_HEADLESS_MCP}
 * @param progressGuardWrites how many DISTINCT earlier paths must already carry
 *                            the exact bytes a write is about to repeat before
 *                            the harness says so and asks (card 262). Default
 *                            <b>3</b>; <b>0 turns the detector off</b>. The
 *                            measured loop wrote the same 283 bytes to 31 paths
 * @param progressGuardFailures how many times in a row one call with
 *                            byte-identical input must fail before the harness
 *                            says so and asks. Default <b>3</b>, and the 3 is
 *                            load-bearing: a flaky test that fails twice and
 *                            then passes must stay silent. 0 turns it off
 * @param progressGuardPlanTurns how many consecutive turns a plan must sit
 *                            unchanged, with a step still open, before the
 *                            harness says so and asks. Default <b>0 — OFF</b>:
 *                            it needs a plan that exists and is maintained, and
 *                            the weak local models this guard was cut for keep
 *                            none. Built, tested, and off until an operator
 *                            turns it on
 * @param questionsPerRun     how many questions ONE run may ask the person, card
 *                            356 finishing card 265's own O3: that card called
 *                            all three ask caps "stated guesses … want a word"
 *                            and shipped them as constants nobody could reach.
 *                            Zero never asks
 * @param maxQuestionOptions  how many choices one question may offer
 * @param maxQuestionChars    how long one question may be
 * @param maxTurns            the runaway-loop brake: how many turns ONE run may
 *                            take before the harness ends it with
 *                            {@code stopReason: "max_turns"}. Card 282 finished
 *                            card 266's owner call 4, which made it an option
 *                            without ever giving it a settings key
 * @param continuationBudget  how many times ONE run may be restarted by the
 *                            harness after it stopped with its own plan still
 *                            open (card 266). Default <b>3</b>; <b>0 turns the
 *                            leash off</b>. It sits beside the guard's counts on
 *                            purpose: an operator tuning one will want the other,
 *                            and the two mechanics share a progress signal
 * @param llamacppBaseUrl     the llama.cpp server's OWN address (card 312);
 *                            {@code null}/blank falls back to the legacy shared
 *                            {@code baseUrl}, then llama-server's documented
 *                            default port 8080. Same no-sentinel rule as
 *                            {@link #effectiveOllamaBaseUrl}. Appended LAST
 *                            rather than placed beside its siblings: both
 *                            neighbours are {@code String}, so a component
 *                            inserted mid-record would let a stale positional
 *                            call compile with the arguments shifted. Env
 *                            {@code SPECTRO_LLAMACPP_BASE_URL}
 * @param commandTimeoutSeconds the wall-clock budget ONE {@code run_command}
 *                            call gets before the child is killed (card 359).
 *                            Default <b>10</b> — the value that was already
 *                            shipping, private and unreachable, when a
 *                            {@code find} over a home directory died under it.
 *                            <b>No ceiling</b>, deliberately: the operator who
 *                            types a number here is the same person the gate
 *                            asks before every shell call, and a cap chosen
 *                            without a measurement would be exactly the
 *                            accidental limit this key exists to remove. Bound
 *                            when the belt is built
 * @param chatReserveWidth    how many pixels of the chat row the dock may never
 *                            take (card 361), in CSS pixels. Default
 *                            <b>360</b>, the value {@code App.tsx} has been
 *                            reserving as a module constant
 * @param dockMaxWidth        the widest the right dock may be dragged, in CSS
 *                            pixels. Default <b>1200</b>, raised from 720 on
 *                            2026-08-14 by card 228 and unreachable ever since.
 *                            Which of the two binds depends on the window: below
 *                            a chat row of roughly 1560 px the reserve decides,
 *                            at or above it this ceiling does — which is why the
 *                            owner made BOTH settings rather than relaxing one
 * @param maxTokens           the completion budget ONE provider call may spend,
 *                            in output tokens (card 364). Default <b>32,000</b>,
 *                            the number {@code Agent.DEFAULT_MAX_TOKENS} has
 *                            been spending since the first commit. It is here
 *                            because {@code AgentOptions.Builder.maxTokens} was
 *                            <b>public, documented and called zero times</b> in
 *                            every main source of every module: the seam existed,
 *                            so the number LOOKED settable, and an audit asking
 *                            "is it parameterised?" scored it as reachable while
 *                            no operator could move it. A backend of its own may
 *                            still clamp below this — the OpenAI-compatible
 *                            provider holds a hard 16,000 per call — so this is
 *                            the ceiling the harness asks for, not a promise
 *                            about what a given model grants
 */
public record SpectroConfig(
        String provider,
        String model,
        String baseUrl,
        Integer compactionThreshold,
        String permissionMode,
        List<String> autoApprove,
        String imageProvider,
        boolean thinking,
        List<McpServerConfig> mcpServers,
        int maxRetries,
        boolean promptCaching,
        List<HookConfig> hooks,
        String workspace,
        String logLevel,
        String imageModel,
        String sttModel,
        String sttProvider,
        String sttLanguage,
        String chromeBinary,
        String otlpEndpoint,
        String otlpBasicAuth,
        String ollamaBaseUrl,
        String lmstudioBaseUrl,
        String searxngUrl,
        boolean allowLocalhost,
        boolean headlessMcp,
        int progressGuardWrites,
        int progressGuardFailures,
        int progressGuardPlanTurns,
        int continuationBudget,
        int maxTurns,
        String llamacppBaseUrl,
        int questionsPerRun,
        int maxQuestionOptions,
        int maxQuestionChars,
        // Cards 359 and 361, APPENDED rather than slotted beside the neighbours
        // they read best next to. FIELD_PROBES is pinned to this list's ORDER
        // and every existing positional caller counts from the front, so a
        // component inserted mid-record moves both. Same reason llamacppBaseUrl
        // sits where it does, one line up.
        int commandTimeoutSeconds,
        int chatReserveWidth,
        int dockMaxWidth,
        // Card 364, appended for the reason the three above were: FIELD_PROBES
        // is pinned to this list's ORDER and every positional caller counts
        // from the front.
        int maxTokens) {

    /**
     * Compat: the pre-card-364 arity, which knew no completion budget. Every
     * caller that built a config positionally keeps compiling and gets the
     * shipped 32,000.
     *
     * @param provider            the backend id
     * @param model               the model id
     * @param baseUrl             the legacy per-provider endpoint override
     * @param compactionThreshold input tokens that trigger compaction
     * @param permissionMode      ask / auto / readonly
     * @param autoApprove         tool names that skip the gate
     * @param imageProvider       which backend draws
     * @param thinking            whether reasoning is on
     * @param mcpServers          the configured MCP servers
     * @param maxRetries          provider retry count
     * @param promptCaching       whether the provider caches prompts
     * @param hooks               the configured shell hooks
     * @param workspace           the pinned workspace, or null
     * @param logLevel            the root log level
     * @param imageModel          the image model id
     * @param sttModel            the speech model id
     * @param sttProvider         which backend transcribes
     * @param sttLanguage         the dictation language
     * @param chromeBinary        an explicit Chrome path
     * @param otlpEndpoint        the OTLP collector
     * @param otlpBasicAuth       its credentials
     * @param ollamaBaseUrl       the ollama endpoint
     * @param lmstudioBaseUrl     the LM Studio endpoint
     * @param searxngUrl          the SearXNG instance
     * @param allowLocalhost      whether the net fence allows loopback
     * @param headlessMcp         whether an unattended run mounts MCP servers
     * @param progressGuardWrites detector 1's count
     * @param progressGuardFailures detector 2's count
     * @param progressGuardPlanTurns detector 3's count
     * @param continuationBudget  how often one run may be restarted
     * @param maxTurns            the per-run turn ceiling
     * @param llamacppBaseUrl     the llama.cpp endpoint
     * @param questionsPerRun     how many questions one run may ask
     * @param maxQuestionOptions  how many options one question may offer
     * @param maxQuestionChars    how long one question may be
     * @param commandTimeoutSeconds the shell budget per run_command call
     * @param chatReserveWidth    the chat row the dock may never take
     * @param dockMaxWidth        the widest the dock may be dragged
     */
    public SpectroConfig(String provider, String model, String baseUrl,
                         Integer compactionThreshold, String permissionMode,
                         List<String> autoApprove, String imageProvider, boolean thinking,
                         List<McpServerConfig> mcpServers, int maxRetries, boolean promptCaching,
                         List<HookConfig> hooks, String workspace, String logLevel,
                         String imageModel, String sttModel, String sttProvider,
                         String sttLanguage, String chromeBinary, String otlpEndpoint,
                         String otlpBasicAuth, String ollamaBaseUrl, String lmstudioBaseUrl,
                         String searxngUrl, boolean allowLocalhost, boolean headlessMcp,
                         int progressGuardWrites, int progressGuardFailures,
                         int progressGuardPlanTurns, int continuationBudget, int maxTurns,
                         String llamacppBaseUrl, int questionsPerRun, int maxQuestionOptions,
                         int maxQuestionChars, int commandTimeoutSeconds,
                         int chatReserveWidth, int dockMaxWidth) {
        this(provider, model, baseUrl, compactionThreshold, permissionMode, autoApprove,
                imageProvider, thinking, mcpServers, maxRetries, promptCaching, hooks,
                workspace, logLevel, imageModel, sttModel, sttProvider, sttLanguage,
                chromeBinary, otlpEndpoint, otlpBasicAuth, ollamaBaseUrl, lmstudioBaseUrl,
                searxngUrl, allowLocalhost, headlessMcp,
                progressGuardWrites, progressGuardFailures, progressGuardPlanTurns,
                continuationBudget, maxTurns, llamacppBaseUrl,
                questionsPerRun, maxQuestionOptions, maxQuestionChars,
                commandTimeoutSeconds, chatReserveWidth, dockMaxWidth,
                DEFAULT_MAX_TOKENS);
    }

    /**
     * Compat: the pre-card-312 arity, which knew no llama.cpp address. Every
     * caller that built a config positionally keeps compiling and gets an unset
     * llama.cpp field, which the address chain reads as "fall back to the
     * legacy baseUrl, then the preset" — the same thing an old config file says.
     *
     * @param provider            the backend name
     * @param model               the model id
     * @param baseUrl             the legacy per-provider endpoint override
     * @param compactionThreshold input tokens that trigger compaction
     * @param permissionMode      how tool permissions are answered
     * @param autoApprove         tool names answered without asking
     * @param imageProvider       which backend renders images
     * @param thinking            whether reasoning is requested
     * @param mcpServers          the configured MCP servers
     * @param maxRetries          provider retry budget
     * @param promptCaching       whether prompt caching is requested
     * @param hooks               the configured shell hooks
     * @param workspace           the working directory
     * @param logLevel            the log level
     * @param imageModel          the image model id
     * @param sttModel            the speech model id
     * @param sttProvider         which backend transcribes
     * @param sttLanguage         the dictation language
     * @param chromeBinary        an explicit Chrome path
     * @param otlpEndpoint        the OTLP collector
     * @param otlpBasicAuth       its credentials
     * @param ollamaBaseUrl       the ollama endpoint
     * @param lmstudioBaseUrl     the LM Studio endpoint
     * @param searxngUrl          the SearXNG instance
     * @param allowLocalhost      whether the net fence allows loopback
     * @param headlessMcp         whether an unattended run mounts MCP servers
     * @param progressGuardWrites detector 1's count
     * @param progressGuardFailures detector 2's count
     * @param progressGuardPlanTurns detector 3's count
     * @param continuationBudget  how often one run may be restarted
     * @param maxTurns            the per-run turn ceiling
     */
    public SpectroConfig(String provider, String model, String baseUrl,
                         Integer compactionThreshold, String permissionMode,
                         List<String> autoApprove, String imageProvider, boolean thinking,
                         List<McpServerConfig> mcpServers, int maxRetries, boolean promptCaching,
                         List<HookConfig> hooks, String workspace, String logLevel,
                         String imageModel, String sttModel, String sttProvider,
                         String sttLanguage, String chromeBinary, String otlpEndpoint,
                         String otlpBasicAuth, String ollamaBaseUrl, String lmstudioBaseUrl,
                         String searxngUrl, boolean allowLocalhost, boolean headlessMcp,
                         int progressGuardWrites, int progressGuardFailures,
                         int progressGuardPlanTurns, int continuationBudget, int maxTurns) {
        this(provider, model, baseUrl, compactionThreshold, permissionMode, autoApprove,
                imageProvider, thinking, mcpServers, maxRetries, promptCaching, hooks,
                workspace, logLevel, imageModel, sttModel, sttProvider, sttLanguage,
                chromeBinary, otlpEndpoint, otlpBasicAuth, ollamaBaseUrl, lmstudioBaseUrl,
                searxngUrl, allowLocalhost, headlessMcp,
                progressGuardWrites, progressGuardFailures, progressGuardPlanTurns,
                continuationBudget, maxTurns, null,
                DEFAULT_QUESTIONS_PER_RUN, DEFAULT_MAX_QUESTION_OPTIONS,
                DEFAULT_MAX_QUESTION_CHARS,
                DEFAULT_COMMAND_TIMEOUT_SECONDS, DEFAULT_CHAT_RESERVE_WIDTH,
                DEFAULT_DOCK_MAX_WIDTH);
    }

    /**
     * Compat: the pre-cards-356/359/361 arity, which knew neither the ask caps
     * nor the shell budget nor the two dock widths. Every caller that built a
     * config positionally — including the tests that pin the layer merge —
     * keeps compiling and gets all six shipped values.
     *
     * <p>THE MERGE THAT PRODUCED THIS. Two branches each added a compat
     * constructor at exactly this arity, each filling only its own three
     * defaults, and the merge left both — one duplicate signature and, worse,
     * two half-answers. Neither branch's tests could see it: the compiler was
     * the judge, which is this house's rule for a textually clean merge that is
     * semantically broken.</p>
     *
     * <p>Added rather than migrating those callers, on the canon's rule for
     * this record: one canonical constructor and compatibility constructors
     * beside it, each differing in ARITY. A test that had to be rewritten to
     * accommodate a new field would be a test whose subject moved under it.</p>
     *
     * @param provider            the backend id
     * @param model               the model id
     * @param baseUrl             the provider endpoint override
     * @param compactionThreshold the token count that triggers compaction
     * @param permissionMode      ask / auto / readonly
     * @param autoApprove         tool names that skip the gate
     * @param imageProvider       which backend draws
     * @param thinking            whether reasoning is on
     * @param mcpServers          the configured MCP servers
     * @param maxRetries          provider retry count
     * @param promptCaching       whether the provider caches prompts
     * @param hooks               the configured hooks
     * @param workspace           the pinned workspace, or null
     * @param logLevel            the root log level
     * @param imageModel          the image model id
     * @param sttModel            the speech model id
     * @param sttProvider         which backend transcribes
     * @param sttLanguage         the dictation language
     * @param chromeBinary        an explicit Chrome path
     * @param otlpEndpoint        the OTLP collector
     * @param otlpBasicAuth       its credentials
     * @param ollamaBaseUrl       the ollama endpoint
     * @param lmstudioBaseUrl     the LM Studio endpoint
     * @param searxngUrl          the SearXNG instance
     * @param allowLocalhost      whether the net fence allows loopback
     * @param headlessMcp         whether an unattended run mounts MCP servers
     * @param progressGuardWrites detector 1's count
     * @param progressGuardFailures detector 2's count
     * @param progressGuardPlanTurns detector 3's count
     * @param continuationBudget  how often one run may be restarted
     * @param maxTurns            the per-run turn ceiling
     * @param llamacppBaseUrl     the llama.cpp endpoint
     */
    public SpectroConfig(String provider, String model, String baseUrl,
                         Integer compactionThreshold, String permissionMode,
                         List<String> autoApprove, String imageProvider, boolean thinking,
                         List<McpServerConfig> mcpServers, int maxRetries, boolean promptCaching,
                         List<HookConfig> hooks, String workspace, String logLevel,
                         String imageModel, String sttModel, String sttProvider,
                         String sttLanguage, String chromeBinary, String otlpEndpoint,
                         String otlpBasicAuth, String ollamaBaseUrl, String lmstudioBaseUrl,
                         String searxngUrl, boolean allowLocalhost, boolean headlessMcp,
                         int progressGuardWrites, int progressGuardFailures,
                         int progressGuardPlanTurns, int continuationBudget, int maxTurns,
                         String llamacppBaseUrl) {
        this(provider, model, baseUrl, compactionThreshold, permissionMode, autoApprove,
                imageProvider, thinking, mcpServers, maxRetries, promptCaching, hooks,
                workspace, logLevel, imageModel, sttModel, sttProvider, sttLanguage,
                chromeBinary, otlpEndpoint, otlpBasicAuth, ollamaBaseUrl, lmstudioBaseUrl,
                searxngUrl, allowLocalhost, headlessMcp,
                progressGuardWrites, progressGuardFailures, progressGuardPlanTurns,
                continuationBudget, maxTurns, llamacppBaseUrl,
                DEFAULT_QUESTIONS_PER_RUN, DEFAULT_MAX_QUESTION_OPTIONS,
                DEFAULT_MAX_QUESTION_CHARS,
                DEFAULT_COMMAND_TIMEOUT_SECONDS, DEFAULT_CHAT_RESERVE_WIDTH,
                DEFAULT_DOCK_MAX_WIDTH);
    }

    /**
     * Compat: the pre-card-262 arity, which knew no progress guard. Every caller
     * that built a config positionally keeps compiling and gets the shipped
     * defaults — both cheap detectors armed, the plan net off.
     *
     * @param provider            the LLM backend, a member of {@link #KNOWN_PROVIDERS}
     * @param model               model id for the chosen provider
     * @param baseUrl             base URL for ollama/openai
     * @param compactionThreshold input-token threshold, or null to derive it
     * @param permissionMode      "ask", "auto" or "readonly"
     * @param autoApprove         permission allowlist
     * @param imageProvider       the image backend
     * @param thinking            whether the reasoning stream is requested
     * @param mcpServers          the configured MCP servers
     * @param maxRetries          provider retry count
     * @param promptCaching       whether prompt caching is on
     * @param hooks               the configured shell hooks
     * @param workspace           the workspace directory, or null for a temp one
     * @param logLevel            file-diagnostics level
     * @param imageModel          the image model id
     * @param sttModel            the speech model id
     * @param sttProvider         the speech backend
     * @param sttLanguage         the dictation language
     * @param chromeBinary        an explicit Chrome path
     * @param otlpEndpoint        the OTLP collector, or null
     * @param otlpBasicAuth       its credentials, or null
     * @param ollamaBaseUrl       the ollama base URL, or null
     * @param lmstudioBaseUrl     the LM Studio base URL, or null
     * @param searxngUrl          the SearXNG instance, or null
     * @param allowLocalhost      whether the net fence permits localhost
     * @param headlessMcp         whether an unattended run may mount MCP servers
     */
    public SpectroConfig(String provider, String model, String baseUrl,
                         Integer compactionThreshold, String permissionMode,
                         List<String> autoApprove, String imageProvider, boolean thinking,
                         List<McpServerConfig> mcpServers, int maxRetries, boolean promptCaching,
                         List<HookConfig> hooks, String workspace, String logLevel,
                         String imageModel, String sttModel, String sttProvider,
                         String sttLanguage, String chromeBinary, String otlpEndpoint,
                         String otlpBasicAuth, String ollamaBaseUrl, String lmstudioBaseUrl,
                         String searxngUrl, boolean allowLocalhost, boolean headlessMcp) {
        this(provider, model, baseUrl, compactionThreshold, permissionMode, autoApprove,
                imageProvider, thinking, mcpServers, maxRetries, promptCaching, hooks,
                workspace, logLevel, imageModel, sttModel, sttProvider, sttLanguage,
                chromeBinary, otlpEndpoint, otlpBasicAuth, ollamaBaseUrl, lmstudioBaseUrl,
                searxngUrl, allowLocalhost, headlessMcp,
                DEFAULT_PROGRESS_WRITES, DEFAULT_PROGRESS_FAILURES, DEFAULT_PROGRESS_PLAN_TURNS,
                DEFAULT_CONTINUATION_BUDGET, DEFAULT_MAX_TURNS, null,
                DEFAULT_QUESTIONS_PER_RUN, DEFAULT_MAX_QUESTION_OPTIONS,
                DEFAULT_MAX_QUESTION_CHARS,
                DEFAULT_COMMAND_TIMEOUT_SECONDS, DEFAULT_CHAT_RESERVE_WIDTH,
                DEFAULT_DOCK_MAX_WIDTH);
    }

    /**
     * Compat: the pre-card-266 arity, which knew no continuation leash. Every
     * caller that built a config positionally keeps compiling and gets the
     * shipped budget.
     *
     * @param provider            the LLM backend, a member of {@link #KNOWN_PROVIDERS}
     * @param model               the model id
     * @param baseUrl             the legacy per-provider endpoint override
     * @param compactionThreshold input tokens that trigger compaction
     * @param permissionMode      how tool permissions are answered
     * @param autoApprove         tool names answered without asking
     * @param imageProvider       which backend renders images
     * @param thinking            whether reasoning is requested
     * @param mcpServers          the configured MCP servers
     * @param maxRetries          provider retry budget
     * @param promptCaching       whether prompt caching is requested
     * @param hooks               the configured shell hooks
     * @param workspace           the working directory
     * @param logLevel            the log level
     * @param imageModel          the image model id
     * @param sttModel            the speech model id
     * @param sttProvider         which backend transcribes
     * @param sttLanguage         the dictation language
     * @param chromeBinary        an explicit Chrome path
     * @param otlpEndpoint        the OTLP collector
     * @param otlpBasicAuth       its credentials
     * @param ollamaBaseUrl       the ollama endpoint
     * @param lmstudioBaseUrl     the LM Studio endpoint
     * @param searxngUrl          the SearXNG instance
     * @param allowLocalhost      whether the net fence allows loopback
     * @param headlessMcp         whether an unattended run mounts MCP servers
     * @param progressGuardWrites detector 1's count
     * @param progressGuardFailures detector 2's count
     * @param progressGuardPlanTurns detector 3's count
     */
    public SpectroConfig(String provider, String model, String baseUrl,
                         Integer compactionThreshold, String permissionMode,
                         List<String> autoApprove, String imageProvider, boolean thinking,
                         List<McpServerConfig> mcpServers, int maxRetries, boolean promptCaching,
                         List<HookConfig> hooks, String workspace, String logLevel,
                         String imageModel, String sttModel, String sttProvider,
                         String sttLanguage, String chromeBinary, String otlpEndpoint,
                         String otlpBasicAuth, String ollamaBaseUrl, String lmstudioBaseUrl,
                         String searxngUrl, boolean allowLocalhost, boolean headlessMcp,
                         int progressGuardWrites, int progressGuardFailures,
                         int progressGuardPlanTurns) {
        this(provider, model, baseUrl, compactionThreshold, permissionMode, autoApprove,
                imageProvider, thinking, mcpServers, maxRetries, promptCaching, hooks,
                workspace, logLevel, imageModel, sttModel, sttProvider, sttLanguage,
                chromeBinary, otlpEndpoint, otlpBasicAuth, ollamaBaseUrl, lmstudioBaseUrl,
                searxngUrl, allowLocalhost, headlessMcp,
                progressGuardWrites, progressGuardFailures, progressGuardPlanTurns,
                DEFAULT_CONTINUATION_BUDGET, DEFAULT_MAX_TURNS, null,
                DEFAULT_QUESTIONS_PER_RUN, DEFAULT_MAX_QUESTION_OPTIONS,
                DEFAULT_MAX_QUESTION_CHARS,
                DEFAULT_COMMAND_TIMEOUT_SECONDS, DEFAULT_CHAT_RESERVE_WIDTH,
                DEFAULT_DOCK_MAX_WIDTH);
    }

    /** The shipped {@code progressGuardWrites}: the same bytes under a third new
     *  name is where "a second copy" stops explaining it. */
    @Governs(kind = Governs.Kind.SETTABLE, unit = Governs.Unit.COUNT, key = "progressGuardWrites")
    public static final int DEFAULT_PROGRESS_WRITES = 3;

    /** The shipped {@code progressGuardFailures}: above the two a flaky test is
     *  allowed, and the counter resets on any success of the same call. */
    @Governs(kind = Governs.Kind.SETTABLE, unit = Governs.Unit.COUNT, key = "progressGuardFailures")
    public static final int DEFAULT_PROGRESS_FAILURES = 3;

    /** The shipped {@code progressGuardPlanTurns}: 0, meaning off. The reason is
     *  on card 262 and in {@code ProgressSettings} — it needs a maintained plan,
     *  and the runs it was cut for keep none. */
    @Governs(kind = Governs.Kind.SETTABLE, unit = Governs.Unit.TURNS, key = "progressGuardPlanTurns")
    public static final int DEFAULT_PROGRESS_PLAN_TURNS = 0;

    /** The shipped {@code continuationBudget}: three restarts of one run. No
     *  budget vocabulary existed anywhere in the owner's sixteen work orders, so
     *  this number is an addition to the house language rather than a recovery
     *  of it — card 266 owner call 2, decided while building. */
    @Governs(kind = Governs.Kind.SETTABLE, unit = Governs.Unit.COUNT, key = "continuationBudget")
    public static final int DEFAULT_CONTINUATION_BUDGET = 3;

    /**
     * The shipped {@code questionsPerRun}: <b>nine</b>.
     *
     * <p>Card 265 shipped three, called it "the concept's number" and listed all
     * three ask caps among its open owner calls as "stated GUESSES … want a
     * word". Card 356 made it settable; card 365 set it, from the owner's word
     * after a census rather than from taste.</p>
     *
     * <p>THE MEASUREMENT, a dated snapshot and not a property — it comes from
     * outside this repo and cannot be re-derived by a test. Over <b>7,139</b>
     * real Claude Code sessions on the owner's machine (2026-09-01), only 127
     * (1.8 %) use the ask tool at all — but of those, <b>16.5 % ask more than
     * three times</b>, p90 is 5 and the largest asked 12. A budget of three
     * therefore failed one asking session in six, and the owner's own run of
     * 2026-08-31 asked four times: it was in that sixth, and the refusal cost it
     * a turn it then ran out of.</p>
     */
    @Governs(kind = Governs.Kind.SETTABLE, unit = Governs.Unit.COUNT, key = "questionsPerRun")
    public static final int DEFAULT_QUESTIONS_PER_RUN = 9;

    /** The shipped {@code maxQuestionOptions}: the bar renders them in a row. */
    @Governs(kind = Governs.Kind.SETTABLE, unit = Governs.Unit.COUNT, key = "maxQuestionOptions")
    public static final int DEFAULT_MAX_QUESTION_OPTIONS = 4;

    /** The shipped {@code maxQuestionChars}: a question is read under time pressure. */
    @Governs(kind = Governs.Kind.SETTABLE, unit = Governs.Unit.CHARACTERS, key = "maxQuestionChars")
    public static final int DEFAULT_MAX_QUESTION_CHARS = 500;

    /** The shipped {@code maxTurns}: the runaway-loop brake, in turns per run.
     *  Card 266 owner call 4 said this becomes an option and 15 stays the value;
     *  {@link dev.spectroscope.core.AgentOptions} got its field in that wave and
     *  the settings chain did not, so until card 282 every browser session ran
     *  on the harness's own fallback with nowhere to change it.
     *
     *  <p>Deliberately a second copy of {@code Agent.DEFAULT_MAX_TURNS} rather
     *  than an import: {@code Agent} reads this package, and the house answer to
     *  a restated number is a test that goes and looks. {@code MaxTurnsSettingTest}
     *  pins the two together, the same way {@code ProgressGuardSettingsTest} pins
     *  the guard's three against {@code ProgressSettings.defaults()}.</p>
     *
     *  <p><b>Card 365 moved it from 15 to 150</b>, and the 15 had never been
     *  measured against anything. DATED SNAPSHOT, 2026-09-01, n = 7,139 real
     *  Claude Code sessions on the owner's machine (7,785 transcript files;
     *  646 were under 2 KB or carried no assistant response). A turn is one
     *  provider round-trip, counted as a unique {@code message.id} — an
     *  assistant LINE is not a turn, there are 2.53 lines per response:</p>
     *
     *  <pre>turns   median 14 · p75 40 · p90 88 · p95 129 · p99 288 · max 1441
     *human inputs   median 1 · p90 2 · p95 4</pre>
     *
     *  <p><b>48.0 % of those sessions exceed 15 turns</b>, so the shipped
     *  ceiling was ending half of all real work in the middle — which is
     *  literally what happened to the owner's run on 2026-08-31, {@code
     *  stopReason: "max_turns"} at step 5 of an 8-step plan. 150 is his number:
     *  above p95 and comfortably above the hundred he asked for.</p>
     *
     *  <p>It stays PROSE and does not become a test, on the canon's own rule:
     *  these figures are not derivable from this repo, so nothing here could
     *  re-derive them and a test would only restate them. They are therefore
     *  stamped with a date and an n rather than presented as a property of the
     *  thing — the census was of Claude Code on a million-token model, not of
     *  spectroscope on an arbitrary backend, and only the shape of the work
     *  transfers. What IS pinned is the decision: {@code MaxTurnsSettingTest}
     *  holds this constant to 150 and to {@code Agent.DEFAULT_MAX_TURNS}.</p> */
    @Governs(kind = Governs.Kind.SETTABLE, unit = Governs.Unit.TURNS, key = "maxTurns")
    public static final int DEFAULT_MAX_TURNS = 150;

    /** The shipped {@code commandTimeoutSeconds}: ten seconds per shell call —
     *  card 359 makes the number reachable and does not move it.
     *
     *  <p>{@code StandardTools} reads THIS rather than keeping a second copy,
     *  because its own copy is where the defect was: the constant was private,
     *  and one line under it {@code run_command}'s model-facing description
     *  typed the same ten as a literal over a parameter its javadoc already
     *  said tests shrink.</p>
     *
     *  <p>No upper bound is enforced, and that is a decision rather than an
     *  oversight (card 359, criterion 3). Every {@code run_command} call passes
     *  the permission gate, so the person who typed a large number here is the
     *  same person approving the call it applies to; a ceiling picked without a
     *  measurement would be a second accidental limit of exactly the kind this
     *  key exists to remove. A non-positive value is not special-cased either —
     *  {@code Process.waitFor} treats it as "do not wait", which fails fast and
     *  visibly rather than hanging.</p> */
    @Governs(kind = Governs.Kind.SETTABLE, unit = Governs.Unit.SECONDS, key = "commandTimeoutSeconds")
    public static final int DEFAULT_COMMAND_TIMEOUT_SECONDS = 10;

    /** The shipped {@code chatReserveWidth}: 360 CSS pixels of the chat row the
     *  right dock may never take. Card 242 introduced the reserve because the
     *  proportional cap before it left the chat at 356 px on a 1150 px window;
     *  card 361 makes the number the operator's. */
    @Governs(kind = Governs.Kind.SETTABLE, unit = Governs.Unit.PIXELS, key = "chatReserveWidth")
    public static final int DEFAULT_CHAT_RESERVE_WIDTH = 360;

    /** The shipped {@code dockMaxWidth}: 1200 CSS pixels, the ceiling card 228
     *  raised from 720 on 2026-08-14 and which has been unreachable since.
     *
     *  <p>It is a separate key from the reserve above because they bind on
     *  different screens: below a chat row of roughly 1560 px the reserve
     *  decides the dock's limit and this ceiling is irrelevant, at or above it
     *  the ceiling decides and the reserve is. Raising only one of them was the
     *  premise card 361 was nearly scoped on, and it would have changed nothing
     *  on the owner's own monitor.</p> */
    @Governs(kind = Governs.Kind.SETTABLE, unit = Governs.Unit.PIXELS, key = "dockMaxWidth")
    public static final int DEFAULT_DOCK_MAX_WIDTH = 1200;

    /** The shipped {@code maxTokens}: 32,000 output tokens per provider call —
     *  card 364 makes the number reachable and does not move it.
     *
     *  <p>A second copy of {@code Agent.DEFAULT_MAX_TOKENS} rather than an
     *  import, for the reason {@link #DEFAULT_MAX_TURNS} carries one: {@code
     *  Agent} reads this package, and the house answer to a restated number is
     *  a test that goes and looks. {@code MaxTokensSettingTest} pins the two
     *  together.</p>
     *
     *  <p><b>No ceiling here</b>, and that is deliberate in the same way
     *  {@link #DEFAULT_COMMAND_TIMEOUT_SECONDS} carries none. The ceilings that
     *  exist belong to the BACKENDS and are enforced where they are known: the
     *  OpenAI-compatible provider clamps every request to its own hard 16,000,
     *  and Anthropic's reasoning budget is derived to stay strictly below
     *  whatever this number is. A second cap invented here would be a limit no
     *  provider asked for, which is the shape card 364 exists to remove.</p> */
    /**
     * The completion budget one provider call may spend, in output tokens.
     *
     * <p>SETTABLE rather than LOOKS_SETTABLE because card 364 made it reachable:
     * {@code .maxTokens(} went from zero shipped call sites to wired on every
     * agent-building path. Before that the builder method existed, was public,
     * and no caller ever passed anything but this number.</p>
     *
     * <p>Card 365 measured it and left it alone — the one default of four that
     * survived the census unchanged. Of 33,810 real responses across 900
     * sessions over 50 KB (2026-09-01), median 355 output tokens, p99 15,408,
     * and only <b>0.21 %</b> exceed 32,000.</p>
     */
     *  and the older Anthropic models — the ones that take a reasoning budget
     *  as a number rather than the adaptive shape — derive that budget to stay
     *  strictly below whatever this number is. A second cap invented here would
     *  be a limit no provider asked for, which is the shape card 364 exists to
     *  remove.</p> */
    @Governs(kind = Governs.Kind.SETTABLE, unit = Governs.Unit.TOKENS, key = "maxTokens")
    public static final int DEFAULT_MAX_TOKENS = 32_000;

    /** Canonical constructor guards against null block fields — callers get empty lists. */
    public SpectroConfig {
        mcpServers = mcpServers == null ? List.of() : List.copyOf(mcpServers);
        hooks = hooks == null ? List.of() : List.copyOf(hooks);
    }

    public static final Path CONFIG_PATH =
            Path.of(System.getProperty("user.home"), ".spectro", "config.json");

    /** The user scope's NEW name; config.json keeps being read underneath for one release.
     *  Public (like {@link #CONFIG_PATH}): the doctor's {@code --migrate} rename and its
     *  own tests live in {@code spectroscope.cli}, outside this package. */
    public static final Path USER_SETTINGS_PATH =
            Path.of(System.getProperty("user.home"), ".spectro", "settings.json");

    /** Project-level settings file, relative to the working directory. */
    public static final String PROJECT_SETTINGS = SpectroDir.project("settings.json");

    /** Workspace-local settings file (machine-local, gitignored by convention) —
     *  sits directly above the workspace's own project settings in the chain,
     *  below only the CLI flags. Relative to the workspace directory, same
     *  shape as {@link #PROJECT_SETTINGS}.
     *
     *  <p>Public (like {@link #PROJECT_SETTINGS}): card 199's allowlist migration
     *  has to visit this layer too, and it lives in another package. It went
     *  unmigrated for exactly as long as it was invisible from outside here. */
    public static final String WS_LOCAL_SETTINGS =
            SpectroDir.project("settings.local.json");

    // Package-private (not private): SettingsWriter's patch validation references
    // these as the single source instead of re-declaring the same literals.
    static final Set<String> KNOWN_PROVIDERS =
            Set.of("anthropic", "ollama", "openai", "lmstudio", "llamacpp",
                    "openrouter", "gemini", "spectro-local");
    /** A stable, human-readable listing of {@link #KNOWN_PROVIDERS} for error
     *  messages — {@link Set#of} has no guaranteed iteration order, so it is
     *  spelled out once and shared by config validation and the live picker
     *  switch instead of being rebuilt (in a different order) in each place. */
    public static final String KNOWN_PROVIDERS_DISPLAY =
            "anthropic, ollama, openai, lmstudio, llamacpp, openrouter, gemini, spectro-local";
    /** {@code imageProvider}'s known values — the factory's own list rather than
     *  a second spelling of it, so a backend added there is accepted here. */
    static final Set<String> KNOWN_IMAGE_PROVIDERS =
            Set.copyOf(dev.spectroscope.core.image.ImageProviders.BACKENDS);
    /** {@code sttProvider}'s known values — "auto" decides by what the machine has. */
    public static final Set<String> KNOWN_STT_PROVIDERS = Set.of("auto", "local", "openai");
    /** {@code sttLanguage}'s known values — "auto" lets the model detect; a code
     *  pins dictation to one language on BOTH transcription routes. */
    public static final Set<String> KNOWN_STT_LANGUAGES = Set.of("auto", "de", "en");
    static final Set<String> KNOWN_LOG_LEVELS =
            Set.of("error", "warn", "info", "debug", "trace");
    /** {@code permissionMode}'s known values — the single source for both the
     *  load-time check below and {@link SettingsWriter}'s write-time check. */
    static final Set<String> KNOWN_PERMISSION_MODES = Set.of("ask", "auto", "readonly");

    private static final SpectroConfig DEFAULTS = new SpectroConfig(
            // compactionThreshold null: unset, so the harness derives it (card 263)
            "anthropic", "claude-opus-4-8", "http://localhost:11434", null, "ask", List.of(),
            "gemini", true, List.of(), 2, true, List.of(), // 2 retries; caching on; no hooks
            null, // workspace: per-session temp folder unless configured
            "info", // logLevel: file diagnostics at info; console stays WARN-quiet
            null, null, // imageModel/sttModel: backend and CLI defaults
            "auto", // sttProvider: hosted when a key is there, local otherwise
            "auto", // sttLanguage: the model detects; a code pins dictation
            null, // chromeBinary: built-in discovery
            null, null, // otlpEndpoint/otlpBasicAuth: exporter off by default
            null, null, // ollamaBaseUrl/lmstudioBaseUrl: unset — the legacy baseUrl chain decides
            null, // searxngUrl: no instance — web_search resolves its tier without one
            false, // allowLocalhost: the net fence refuses loopback until somebody says otherwise
            false, // headlessMcp: an unattended run mounts no MCP server until an operator opts in
            // Card 262, the progress guard: identical bytes under a new name and
            // a call failing on unchanged input both speak at three; the plan net
            // ships off, because it needs a plan the weak models never write.
            3, 3, 0,
            // Card 266: three continuations per run, on the attended faces only —
            // the WIRING is the fence, exactly as it is for the guard above.
            3,
            // Card 282 named this key; card 365 set its number. ONE HUNDRED AND
            // FIFTY, not the fifteen this comment claimed until the merge — the
            // owner's figure after a census of 7,139 real sessions on his own
            // machine, where the median run takes 14 turns, p90 is 88, and
            // **48.0 % exceed fifteen**. The old default ended half of real work
            // mid-run. Card 364 is what makes this number reach more than the
            // browser session: `.maxTurns(` has one call site today.
            DEFAULT_MAX_TURNS,
            null, // llamacppBaseUrl: unset — the legacy baseUrl chain decides
            // Card 356 with card 365's number: nine questions per run. Card 265
            // called all three caps guesses awaiting the owner's word; he gave it
            // after a census of 7,139 real sessions, of which 16.5 % of the ones
            // that ask at all ask more than three times.
            DEFAULT_QUESTIONS_PER_RUN, DEFAULT_MAX_QUESTION_OPTIONS,
            DEFAULT_MAX_QUESTION_CHARS,
            // Cards 359 and 361: the shell budget and the two dock widths, each
            // shipping the value it already had as an unreachable literal.
            DEFAULT_COMMAND_TIMEOUT_SECONDS, DEFAULT_CHAT_RESERVE_WIDTH, DEFAULT_DOCK_MAX_WIDTH,
            // Card 364: the number the harness has always spent, now reachable.
            DEFAULT_MAX_TOKENS);

    private static final ObjectMapper JSON = new ObjectMapper();

    /**
     * Overrides from the CLI flags. Each field is nullable: a null means "not set
     * on the command line" and leaves the lower layers in place.
     *
     * @param provider            the {@code --provider} flag; null when not given
     * @param model               the {@code --model} flag; null when not given
     * @param baseUrl             the {@code --base-url} flag; null when not given
     * @param compactionThreshold the {@code --compaction-threshold} flag; null when not given
     * @param permissionMode      permission-mode override (ask/auto/readonly); null when not given
     * @param workspace           the {@code --workspace} flag; null when not given
     */
    public record Overrides(
            String provider,
            String model,
            String baseUrl,
            Integer compactionThreshold,
            String permissionMode,
            String workspace) {

        /** The all-null overrides for callers without a command line (server boot, tests).
         *  @return overrides that defer every field to the layers below */
        public static Overrides none() {
            return new Overrides(null, null, null, null, null, null);
        }
    }

    /**
     * Where a resolved field's value came from — the settings UI's provenance
     * view (e.g. "workspace: from user settings; env shadowed").
     *
     * @param winner   the layer name that supplied the value ({@code "defaults"}
     *                 when no scope set it at all); one of {@code "defaults"},
     *                 {@code "env"}, {@code "user"}, {@code "launch-dir"},
     *                 {@code "project"}, {@code "local"}, {@code "flags"}
     * @param shadowed lower layers that also supplied a value but were
     *                 overridden by the winner, highest (closest to the
     *                 winner) first
     */
    public record Origin(String winner, List<String> shadowed) {}

    /**
     * The effective configuration alongside a full provenance trail: which
     * layer won each resolvable field (see {@link Origin}), and the raw
     * non-empty scopes as JSON — the settings API's "layers" view.
     *
     * @param config  the effective, validated configuration — identical to
     *                what {@link #load} returns for the same arguments
     * @param origins per-field winner + shadowed layers, keyed by field name
     * @param layers  each non-empty scope's own settings as JSON, keyed by
     *                layer name ({@code "env"}, {@code "user"},
     *                {@code "launch-dir"}, {@code "project"}, {@code "local"},
     *                {@code "flags"}); a scope that set nothing at all is
     *                simply absent from the map, never present as {@code {}}
     */
    public record Resolved(SpectroConfig config, Map<String, Origin> origins, Map<String, JsonNode> layers) {}

    /** Convenience loader: the project layer resolves at the current working directory.
     *  @param overrides the CLI layer — null fields defer to the hierarchy below
     *  @return the effective, validated configuration */
    public static SpectroConfig load(Overrides overrides) {
        return load(overrides, Path.of(System.getProperty("user.dir")));
    }

    /**
     * Loads the full hierarchy: defaults, then the environment (SPECTRO_*), then
     * ~/.spectro/settings.json (config.json compat), then
     * {@code projectDir}/.spectro/settings.json, then the CLI overrides.
     * A missing file at any layer is fine; malformed JSON fails loudly on
     * purpose — a broken config is a programming error, not something to
     * silently ignore.
     *
     * @param overrides  the CLI layer — null fields defer to the hierarchy below
     * @param projectDir directory whose {@code .spectro/settings.json} forms the project layer
     * @return the effective, validated configuration
     */
    public static SpectroConfig load(Overrides overrides, Path projectDir) {
        return load(overrides, projectDir, System.getenv());
    }

    /** Visible for tests: the environment layer (SPECTRO_PROVIDER/MODEL/BASE_URL,
     *  typically fed from ./.env) is injectable. Precedence: defaults &lt;
     *  environment &lt; user settings (~/.spectro/settings.json, with
     *  ~/.spectro/config.json underneath as compat) &lt; project settings &lt; flags —
     *  env is the BASE directly above the defaults; settings files call the shots.
     *  Delegates to the 4-arg overload with a {@code null} workspace — the
     *  process-moment view, with no workspace scopes in the chain.
     *  @param overrides  the CLI layer, highest precedence
     *  @param projectDir directory whose {@code .spectro/settings.json} forms the project layer
     *  @param env        the environment layer — injectable so tests need no real env
     *  @return the effective, validated configuration */
    static SpectroConfig load(Overrides overrides, Path projectDir, Map<String, String> env) {
        return load(overrides, projectDir, null, env);
    }

    /**
     * Session-moment load: once a session's workspace is resolved (see
     * {@code WorkspaceResolver}), its own {@code .spectro} settings pair joins
     * the chain directly below the CLI flags — the folder the agent actually
     * works in gets the loudest settings voice short of a flag. Reads
     * {@code System.getenv()} for the environment layer.
     *
     * @param overrides  the CLI layer, highest precedence
     * @param projectDir directory whose {@code .spectro/settings.json} forms the launch-dir layer
     * @param workspace  the resolved workspace directory whose own {@code .spectro}
     *                   pair (project, then local) joins the chain
     * @return the effective, validated configuration
     */
    public static SpectroConfig loadForWorkspace(Overrides overrides, Path projectDir, Path workspace) {
        return load(overrides, projectDir, workspace, System.getenv());
    }

    /** Visible for tests: the workspace layer is injectable alongside the
     *  environment. Precedence: defaults &lt; environment &lt; user settings
     *  (~/.spectro/settings.json, with ~/.spectro/config.json underneath as compat)
     *  &lt; launch-dir project settings &lt; the workspace's own project settings
     *  &lt; the workspace's local settings &lt; flags — env is the BASE directly
     *  above the defaults; every settings file calls the shots above it. A
     *  {@code null} workspace omits both workspace scopes entirely — the
     *  process-moment view used before a session resolves one, and the exact
     *  behaviour of the 3-arg overload above. Delegates to {@link #loadResolved}
     *  and discards its provenance — callers that want the "why" use that
     *  method directly.
     *  @param overrides  the CLI layer, highest precedence
     *  @param projectDir directory whose {@code .spectro/settings.json} forms the launch-dir layer
     *  @param workspace  the resolved workspace directory, or {@code null} to skip
     *                     the workspace scopes entirely
     *  @param env        the environment layer — injectable so tests need no real env
     *  @return the effective, validated configuration */
    static SpectroConfig load(Overrides overrides, Path projectDir, Path workspace,
                            Map<String, String> env) {
        return loadResolved(overrides, projectDir, workspace, env).config();
    }

    /**
     * Session-moment load with a full provenance trail: which layer won each
     * resolvable field (see {@link Origin}) and the non-empty scopes as raw
     * JSON (the settings API's "layers" view) — the same resolution
     * {@link #load}/{@link #loadForWorkspace} perform, with the "why" kept
     * instead of thrown away. Reads {@code System.getenv()} for the
     * environment layer.
     *
     * @param overrides  the CLI layer, highest precedence
     * @param projectDir directory whose {@code .spectro/settings.json} forms the launch-dir layer
     * @param workspace  the resolved workspace directory whose own {@code .spectro}
     *                   pair (project, then local) joins the chain, or
     *                   {@code null} to skip both workspace scopes
     * @return the effective configuration alongside its provenance
     */
    public static Resolved loadResolved(Overrides overrides, Path projectDir, Path workspace) {
        return loadResolved(overrides, projectDir, workspace, System.getenv());
    }

    /**
     * Visible for tests: the environment layer is injectable alongside the
     * workspace. Builds the SAME scope chain {@code load} used to fold by
     * hand — env, user (config.json overridden by settings.json), launch-dir,
     * then (only when {@code workspace} is given) the workspace's own project
     * and local settings, then flags — folds it into one effective config
     * exactly as before (see {@link #finishResolve}), and probes the
     * identical scopes a second time per field to build the provenance map,
     * so the reported origins can never drift from what the fold actually used.
     *
     * @param overrides  the CLI layer, highest precedence
     * @param projectDir directory whose {@code .spectro/settings.json} forms the launch-dir layer
     * @param workspace  the resolved workspace directory, or {@code null} to skip
     *                   the workspace scopes entirely
     * @param env        the environment layer — injectable so tests need no real env
     * @return the effective configuration alongside its provenance
     */
    static Resolved loadResolved(Overrides overrides, Path projectDir, Path workspace,
            Map<String, String> env) {
        List<Scope> scopes = new ArrayList<>();
        scopes.add(new Scope("env", PartialConfig.envLayer(env)));
        scopes.add(new Scope("user", readFile(CONFIG_PATH).overriddenBy(readFile(USER_SETTINGS_PATH))));
        scopes.add(new Scope("launch-dir", readFile(projectDir.resolve(PROJECT_SETTINGS))));
        // Built here rather than appended below because the refusal's cost
        // reading (card 354) needs the whole ALLOWED chain, and flags are part
        // of it — a --workspace on the command line carries the key the folder
        // was refused for. It still joins the fold last, so precedence is
        // unchanged.
        Scope flags = new Scope("flags", PartialConfig.fromOverrides(overrides));
        if (workspace != null) {
            Path wsProjectFile = workspace.resolve(PROJECT_SETTINGS);
            Path wsLocalFile = workspace.resolve(WS_LOCAL_SETTINGS);
            PartialConfig wsProject = readFile(wsProjectFile);
            PartialConfig wsLocal = readFile(wsLocalFile);
            List<Scope> allowed = new ArrayList<>(scopes);
            allowed.add(flags);
            rejectProcessGlobals(wsProject, wsProjectFile, allowed);
            rejectProcessGlobals(wsLocal, wsLocalFile, allowed);
            scopes.add(new Scope("project", wsProject));
            scopes.add(new Scope("local", wsLocal));
        }
        scopes.add(flags);

        // One ascending-precedence fold, scope by scope — the direct successor
        // of the old hand-wired chain: defaults < env < user settings <
        // launch-dir settings < workspace settings (project, then local) < flags.
        PartialConfig folded = new PartialConfig();
        for (Scope scope : scopes) {
            folded = folded.overriddenBy(scope.partial());
        }
        SpectroConfig config = finishResolve(folded);

        // Provenance: re-walk the SAME scopes per field, on each scope's own
        // (pre-fold) partial — so a whole-block field like mcpServers/hooks is
        // attributed to whichever layer set the block, never to a layer that
        // merely left an inner key standing.
        Map<String, Origin> origins = new LinkedHashMap<>();
        for (FieldProbe probe : FIELD_PROBES) {
            String winner = "defaults";
            List<String> shadowed = new ArrayList<>();
            for (Scope scope : scopes) {                       // ascending: last hit wins
                if (probe.get().apply(scope.partial()) != null) {
                    if (!"defaults".equals(winner)) {
                        shadowed.add(winner);
                    }
                    winner = scope.name();
                }
            }
            Collections.reverse(shadowed);                     // highest shadowed first
            origins.put(probe.name(), new Origin(winner, List.copyOf(shadowed)));
        }

        // Layers view: each scope's own settings as sparse JSON, present only
        // when the scope actually set something (an absent scope is absent,
        // never {}).
        Map<String, JsonNode> layers = new LinkedHashMap<>();
        for (Scope scope : scopes) {
            JsonNode node = JSON.valueToTree(scope.partial());
            if (node.isObject() && !node.isEmpty()) {
                layers.put(scope.name(), node);
            }
        }
        return new Resolved(config, origins, layers);
    }

    /** First-boot seed: when NO user file exists (neither settings.json nor the
     *  legacy config.json), materialize the env base into ~/.spectro/settings.json —
     *  the user sees their exact current behavior in the new file and the Settings
     *  page, and day one changes nothing functionally. Secrets never enter.
     *  {@code CREATE_NEW} makes the existence check and the write one atomic
     *  filesystem operation — a racing process that seeds first is discovered
     *  as a (caught, ignored) {@code FileAlreadyExistsException} instead of a
     *  clobbered file, closing the exists-then-write gap the earlier
     *  {@code Files.exists} check left open.
     *  <p>Deliberately {@link PartialConfig#fromEnv} and NOT
     *  {@link PartialConfig#envLayer}: the seed materializes the PROCESS
     *  environment only. The {@code ~/.spectro/.env} fallback the env layer
     *  gained for the OTLP pair must not reach this write, or a credential the
     *  installer put in a 0600 file would be copied into a settings document
     *  the UI, the settings API and every layer dump read back.
     *  @param env the environment layer — injectable so tests need no real env
     *  @return true when this call just wrote a fresh {@code settings.json};
     *          false when a user scope already existed, there was nothing in
     *          the env worth seeding, or a racing process won instead — the
     *          doctor face reports this line only when it actually fired */
    public static boolean ensureSeeded(Map<String, String> env) {
        if (Files.exists(USER_SETTINGS_PATH) || Files.exists(CONFIG_PATH)) {
            return false;
        }
        PartialConfig fromEnv = PartialConfig.fromEnv(env);
        JsonNode node = JSON.valueToTree(fromEnv);
        if (!node.isObject() || node.isEmpty()) {
            return false;                        // nothing to seed
        }
        try {
            Files.createDirectories(USER_SETTINGS_PATH.getParent());
            Files.writeString(USER_SETTINGS_PATH,
                    JSON.writerWithDefaultPrettyPrinter().writeValueAsString(node),
                    StandardOpenOption.CREATE_NEW);
            return true;
        } catch (IOException ignored) {
            // Seeding is a convenience — a read-only home never blocks a run,
            // and CREATE_NEW racing into FileAlreadyExistsException just means
            // another process seeded first; both are equally "not seeded here".
            return false;
        }
    }

    /** Finishes a fully-folded partial into the effective config: fills every
     *  remaining gap from DEFAULTS, validates the known-value fields, and
     *  applies the local-provider model fallback when no layer named a model
     *  explicitly. Extracted verbatim from the pre-Task-6 {@code load} body —
     *  {@link #loadResolved} is now its only caller.
     *  @param folded the fully-folded partial (every scope applied, ascending)
     *  @return the effective, validated configuration */
    private static SpectroConfig finishResolve(PartialConfig folded) {
        // Any non-default layer setting model — files, env or the flag — counts
        // as explicit; only then do we skip the local-provider fallback below.
        boolean explicitModel = folded.model != null;
        SpectroConfig base = folded.merged();

        validateKnown("provider", base.provider(), KNOWN_PROVIDERS,
                KNOWN_PROVIDERS_DISPLAY);
        validateKnown("image provider", base.imageProvider(), KNOWN_IMAGE_PROVIDERS,
                "gemini, openai");
        // A typo must not silently disable what the owner configured — the same
        // reasoning that already covered provider/imageProvider/logLevel now
        // covers permissionMode too (it used to load unchecked).
        validateKnown("permissionMode", base.permissionMode(), KNOWN_PERMISSION_MODES,
                "ask, auto, readonly");
        validateKnown("sttProvider", base.sttProvider(), KNOWN_STT_PROVIDERS,
                "auto, local, openai");
        validateKnown("sttLanguage", base.sttLanguage(), KNOWN_STT_LANGUAGES,
                "auto, de, en");
        validateKnown("logLevel", base.logLevel(), KNOWN_LOG_LEVELS,
                "error, warn, info, debug, trace");

        // Local providers without an explicitly set model: use sensible local defaults
        // instead of the Claude id.
        if (!explicitModel) {
            String fallback = defaultModelFor(base.provider());
            if (fallback != null && !fallback.equals(base.model())) {
                base = new SpectroConfig(base.provider(), fallback, base.baseUrl(),
                        base.compactionThreshold(), base.permissionMode(), base.autoApprove(),
                        base.imageProvider(), base.thinking(), base.mcpServers(),
                        base.maxRetries(), base.promptCaching(), base.hooks(),
                        base.workspace(), base.logLevel(),
                        base.imageModel(), base.sttModel(), base.sttProvider(),
                        base.sttLanguage(), base.chromeBinary(),
                        base.otlpEndpoint(), base.otlpBasicAuth(),
                        base.ollamaBaseUrl(), base.lmstudioBaseUrl(), base.searxngUrl(),
                        base.allowLocalhost(), base.headlessMcp(),
                        base.progressGuardWrites(), base.progressGuardFailures(),
                        base.progressGuardPlanTurns(), base.continuationBudget(),
                        base.maxTurns(), base.llamacppBaseUrl(),
                        base.questionsPerRun(), base.maxQuestionOptions(),
                        base.maxQuestionChars(),
                        base.commandTimeoutSeconds(), base.chatReserveWidth(),
                        base.dockMaxWidth(), base.maxTokens());
            }
        }
        return base;
    }

    /** One named layer in the resolution chain, paired with its own (pre-fold)
     *  partial — provenance probing reads this directly, never the fold, so a
     *  whole-block field (mcpServers, hooks) is attributed to the layer that
     *  set the block, not to whichever layer happens to leave an inner key
     *  standing after the fold.
     *  @param name    the layer name surfaced in {@link Origin} and {@link Resolved#layers()}
     *  @param partial that layer's own settings, independent of every other scope */
    private record Scope(String name, PartialConfig partial) {}

    /** One resolvable field, named for {@link Origin} and read straight off a
     *  single scope's partial (never the fold) so provenance probing can ask
     *  "did THIS layer set this field" independent of any other layer.
     *  @param name the field name as it appears in {@link Resolved#origins()}
     *  @param get  reads this field off one scope's partial; {@code null} means unset */
    private record FieldProbe(String name, Function<PartialConfig, Object> get) {}

    /** Every resolvable field, in {@link SpectroConfig}'s record-component order —
     *  drives the per-field provenance loop in {@link #loadResolved}. */
    private static final List<FieldProbe> FIELD_PROBES = List.of(
            new FieldProbe("provider", p -> p.provider),
            new FieldProbe("model", p -> p.model),
            new FieldProbe("baseUrl", p -> p.baseUrl),
            new FieldProbe("compactionThreshold", p -> p.compactionThreshold),
            new FieldProbe("permissionMode", p -> p.permissionMode),
            new FieldProbe("autoApprove", p -> p.autoApprove),
            new FieldProbe("imageProvider", p -> p.imageProvider),
            new FieldProbe("thinking", p -> p.thinking),
            new FieldProbe("mcpServers", p -> p.mcpServers),
            new FieldProbe("maxRetries", p -> p.maxRetries),
            new FieldProbe("promptCaching", p -> p.promptCaching),
            new FieldProbe("hooks", p -> p.hooks),
            new FieldProbe("workspace", p -> p.workspace),
            new FieldProbe("logLevel", p -> p.logLevel),
            new FieldProbe("imageModel", p -> p.imageModel),
            new FieldProbe("sttModel", p -> p.sttModel),
            new FieldProbe("sttProvider", p -> p.sttProvider),
            new FieldProbe("sttLanguage", p -> p.sttLanguage),
            new FieldProbe("chromeBinary", p -> p.chromeBinary),
            new FieldProbe("otlpEndpoint", p -> p.otlpEndpoint),
            new FieldProbe("otlpBasicAuth", p -> p.otlpBasicAuth),
            new FieldProbe("ollamaBaseUrl", p -> p.ollamaBaseUrl),
            new FieldProbe("lmstudioBaseUrl", p -> p.lmstudioBaseUrl),
            new FieldProbe("searxngUrl", p -> p.searxngUrl),
            new FieldProbe("allowLocalhost", p -> p.allowLocalhost),
            new FieldProbe("headlessMcp", p -> p.headlessMcp),
            new FieldProbe("progressGuardWrites", p -> p.progressGuardWrites),
            new FieldProbe("progressGuardFailures", p -> p.progressGuardFailures),
            new FieldProbe("progressGuardPlanTurns", p -> p.progressGuardPlanTurns),
            new FieldProbe("continuationBudget", p -> p.continuationBudget),
            new FieldProbe("maxTurns", p -> p.maxTurns),
            // Card 312 — LAST, because the probe list is pinned to the record's
            // component ORDER and llamacppBaseUrl was appended rather than
            // slotted beside its siblings.
            new FieldProbe("llamacppBaseUrl", p -> p.llamacppBaseUrl),
            // Card 356 — after llamacppBaseUrl, because that is where the record
            // puts them. The note above is not decoration: this list was first
            // written with these three slotted beside maxTurns, where they READ
            // better and where the drift guard immediately said no.
            new FieldProbe("questionsPerRun", p -> p.questionsPerRun),
            new FieldProbe("maxQuestionOptions", p -> p.maxQuestionOptions),
            new FieldProbe("maxQuestionChars", p -> p.maxQuestionChars),
            // Cards 359 and 361 — after llamacppBaseUrl, for the same reason it
            // sits last: this list is pinned to the record's component ORDER,
            // and these three were appended to the record rather than slotted
            // beside the fields they read best next to.
            new FieldProbe("commandTimeoutSeconds", p -> p.commandTimeoutSeconds),
            new FieldProbe("chatReserveWidth", p -> p.chatReserveWidth),
            new FieldProbe("dockMaxWidth", p -> p.dockMaxWidth),
            // Card 364 — appended last, same rule.
            new FieldProbe("maxTokens", p -> p.maxTokens));

    /** The provenance probes' field names, in {@link #FIELD_PROBES} order — for
     *  the reflective pin only: {@code KnownKeysDriftTest} holds the probe list
     *  to the record components (card 232), because a component without a probe
     *  resolves fine and then reports no origin, which no other test notices.
     *  @return every probed field name, in probe order */
    static List<String> fieldProbeNames() {
        return FIELD_PROBES.stream().map(FieldProbe::name).toList();
    }

    /**
     * A key a workspace scope must not set: its name in the file, the probe
     * that finds it in a parsed scope, the rule it breaks and where it belongs
     * instead.
     *
     * @param key   the settings key as an operator writes it
     * @param get   reads it off one parsed scope; {@code null} means unset
     * @param rule  the clause after the key name, naming the rule it breaks
     * @param hint  where the key belongs instead, and why it may not live here
     */
    private record ProcessGlobal(String key, Function<PartialConfig, Object> get,
            String rule, String hint) {
    }

    /**
     * The keys a workspace scope may not hold. ONE list, because the reason is
     * one reason: the workspace is the folder the agent itself writes into, so
     * a key that steers the agent's own machinery cannot be honoured from
     * inside it. Card 199 wrote it for the net fence — "a fence whose switch
     * lives inside the sandbox it guards can be flipped by the thing it
     * guards" — and card 222's review found two more keys of the same kind
     * that were never added.
     *
     * <p>A list rather than a run of hand-written {@code if}s so the published
     * config reference can be checked against it (ConfigDocDriftTest): a key
     * added here without a word in the guide is a refusal an operator meets
     * with no way to look it up.</p>
     */
    private static final List<ProcessGlobal> WORKSPACE_SCOPE_FORBIDDEN = List.of(
            new ProcessGlobal("workspace", p -> p.workspace,
                    "is not allowed in a workspace scope",
                    "a folder must not point the agent at a different folder."),
            new ProcessGlobal("logLevel", p -> p.logLevel,
                    "is process-global and not allowed in a workspace scope",
                    "set it in ~/.spectro/settings.json or SPECTRO_LOG_LEVEL."),
            // Card 199, review finding F4: the workspace is the agent's own cwd,
            // and write_file writes into it.
            new ProcessGlobal("allowLocalhost", p -> p.allowLocalhost,
                    "is process-global and not allowed in a workspace scope",
                    "the net fence's opt-in belongs in ~/.spectro/settings.json or "
                            + "SPECTRO_ALLOW_LOCALHOST, not in a folder the agent writes into."),
            // Card 222, review finding F2. This one did not LOOK like a switch:
            // it names an executable that browse_page launches. An operator
            // approving "browse_page https://…" approves a look at a page, not
            // the launch of a binary the agent chose — and card 222 shortened
            // the reach of a planted file from the next session to the next
            // tool call.
            new ProcessGlobal("chromeBinary", p -> p.chromeBinary,
                    "is process-global and not allowed in a workspace scope",
                    "the browser binary browse_page launches belongs in "
                            + "~/.spectro/settings.json or SPECTRO_CHROME, not in a folder the "
                            + "agent writes into."),
            // The quieter twin of the line above, and measured: SearxngSearcher
            // takes no NetFence at all, so this key decides an address
            // web_search GETs with the loopback opt-in still off. The settings
            // page writes it to the USER scope, so refusing it here costs an
            // operator nothing.
            new ProcessGlobal("searxngUrl", p -> p.searxngUrl,
                    "is process-global and not allowed in a workspace scope",
                    "the instance web_search dials belongs in ~/.spectro/settings.json or "
                            + "SPECTRO_SEARXNG_URL, not in a folder the agent writes into."),
            // Card 220: the switch that lets an UNATTENDED run mount MCP servers.
            // Same rule as allowLocalhost, sharper stakes: the workspace is the
            // folder the agent itself writes into, so a consent switch living
            // there could be flipped by one auto-approved write_file — and the
            // next cron fire in that workspace would mount every configured
            // server with nobody watching.
            new ProcessGlobal("headlessMcp", p -> p.headlessMcp,
                    "is process-global and not allowed in a workspace scope",
                    "the headless MCP opt-in belongs in ~/.spectro/settings.json or "
                            + "SPECTRO_HEADLESS_MCP, not in a folder the agent writes into."),
            // Card 281: the guard's three counts, and the sharpest case on this
            // list. The others let a folder redirect or widen what the agent may
            // do; these let it switch off the detector that is WATCHING it. Zero
            // is the off value, a workspace is the folder the agent writes into,
            // and the loop that wrote the same file thirty-one times could have
            // ended that inspection by writing a thirty-second.
            new ProcessGlobal("progressGuardWrites", p -> p.progressGuardWrites,
                    "is process-global and not allowed in a workspace scope",
                    "the progress guard's counts belong in ~/.spectro/settings.json, not in "
                            + "a folder the agent writes into — a workspace that can set them "
                            + "to zero can disarm the guard watching it."),
            new ProcessGlobal("progressGuardFailures", p -> p.progressGuardFailures,
                    "is process-global and not allowed in a workspace scope",
                    "the progress guard's counts belong in ~/.spectro/settings.json, not in "
                            + "a folder the agent writes into — a workspace that can set them "
                            + "to zero can disarm the guard watching it."),
            new ProcessGlobal("progressGuardPlanTurns", p -> p.progressGuardPlanTurns,
                    "is process-global and not allowed in a workspace scope",
                    "the progress guard's counts belong in ~/.spectro/settings.json, not in "
                            + "a folder the agent writes into — a workspace that can set them "
                            + "to zero can disarm the guard watching it."));

    /** The keys a workspace scope may not hold, by name. Exists for the doc
     *  guard: a key added to the list above without a word in the published
     *  config reference is a refusal an operator meets with nowhere to look it
     *  up.
     *  @return the forbidden keys, in the order they are checked */
    static List<String> workspaceScopeForbiddenKeys() {
        return WORKSPACE_SCOPE_FORBIDDEN.stream().map(ProcessGlobal::key).toList();
    }

    /** Applies {@link #WORKSPACE_SCOPE_FORBIDDEN} to one parsed workspace
     *  scope. Fails loudly, naming the offending file — a workspace scope is
     *  meant to be portable (the project half even checked in), so a folder
     *  silently redirecting the agent, hijacking process-wide logging or
     *  choosing what a tool dials would be a surprise nobody could debug from
     *  the settings alone.
     *
     *  <p>Card 354 adds the reading of what the refusal COSTS, and takes it
     *  HERE rather than at any of the catch sites. The scopes that are allowed
     *  to carry these keys have just been read a few lines above, so the
     *  question is answered from the same reading that refused — a catch site
     *  asking later would re-read the files and could answer about a different
     *  moment.</p>
     *
     *  <p><b>The reading is about the FILE, not about the key that tripped it.</b>
     *  The throw below leaves on the first forbidden key and abandons the whole
     *  scope, so a settings file's OTHER keys are dropped with it and never
     *  reach the fold. A per-key reading therefore prices the wrong thing: the
     *  owner's own ForgeDemo scope asks for {@code allowLocalhost}, which his
     *  user scope carries anyway, AND for {@code permissionMode}, which nothing
     *  else sets — priced per key that refusal reads as free and its notice is
     *  worth suppressing, while he silently loses his permission mode. So
     *  {@link #nothingIsLost} walks every field the refused scope set, each one
     *  through its own {@link #FIELD_PROBES} probe, and {@code inForce} is true
     *  only when dropping this file changes nothing at all.</p>
     *
     *  @param scope   the parsed workspace-scope layer (project or local)
     *  @param file    the file it was read from, named in the thrown message
     *  @param allowed the layers that ARE allowed to carry these keys, in
     *                 ascending precedence — the last one to set a key wins it
     *  @throws WorkspaceScopeRefused when the scope sets a forbidden field */
    private static void rejectProcessGlobals(PartialConfig scope, Path file, List<Scope> allowed) {
        for (ProcessGlobal forbidden : WORKSPACE_SCOPE_FORBIDDEN) {
            Object wanted = forbidden.get().apply(scope);
            if (wanted != null) {
                boolean free = nothingIsLost(scope, allowed);
                String carrier = carrierOf(forbidden.get(), wanted, allowed);
                throw new WorkspaceScopeRefused(forbidden.key(), file.toString(),
                        forbidden.hint(), free, free ? carrier : null,
                        "\"" + forbidden.key() + "\" " + forbidden.rule()
                                + " (" + file + ") — " + forbidden.hint());
            }
        }
    }

    /** Whether dropping the refused scope costs the operator nothing: every
     *  field it set is already carried, at the SAME value, by a layer that is
     *  allowed to carry it.
     *
     *  <p>Every field, not only the forbidden one that tripped the refusal,
     *  because the throw takes the whole scope with it. A file that asks for a
     *  refused key its user scope grants anyway AND for one ordinary key nobody
     *  else sets is a real loss, and pricing it per key reports it as free.</p>
     *
     *  <p>{@link #FIELD_PROBES} rather than a list written here: it is the same
     *  list the fold's provenance walk uses and it is held to the record's
     *  components by {@code KnownKeysDriftTest}, so a settings key added to the
     *  shape is priced without anyone remembering to come back.</p>
     *
     *  @param refused the parsed workspace scope that is about to be thrown away
     *  @param allowed the allowed layers, ascending
     *  @return true when nothing this scope asked for is being lost */
    private static boolean nothingIsLost(PartialConfig refused, List<Scope> allowed) {
        for (FieldProbe probe : FIELD_PROBES) {
            Object wanted = probe.get().apply(refused);
            if (wanted != null && carrierOf(probe.get(), wanted, allowed) == null) {
                return false;
            }
        }
        return true;
    }

    /** The allowed layer that already carries {@code wanted} for one field, or
     *  {@code null} when that field is really being lost.
     *
     *  <p>Ascending, so the last hit is the winner of the fold — the same
     *  direction {@link #loadResolved} walks for provenance, over the very same
     *  {@link Scope} objects. Unlike that walk it also compares the VALUE, and
     *  that is the whole difference between a useful answer and a wrong one: a
     *  layer setting the field the OTHER way clears the answer rather than
     *  keeping an earlier agreement, because that layer wins the fold and the
     *  workspace's request is therefore not in force no matter who agreed with
     *  it further down.</p>
     *
     *  @param probe   reads the field off one layer; {@code null} means unset
     *  @param wanted  the value the refused workspace scope asked for
     *  @param allowed the allowed layers, ascending
     *  @return the winning layer's name when it carries {@code wanted}, else null */
    private static String carrierOf(Function<PartialConfig, Object> probe, Object wanted,
            List<Scope> allowed) {
        String carrier = null;
        for (Scope scope : allowed) {
            Object value = probe.apply(scope.partial());
            if (value != null) {
                carrier = wanted.equals(value) ? scope.name() : null;
            }
        }
        return carrier;
    }

    /**
     * A workspace scope named a process-global key, with the parts kept apart.
     *
     * <p>Card 285: the message alone was all the reader got, so every surface
     * had to re-parse prose to say anything specific, and none did. It stays an
     * {@link IllegalArgumentException} so the existing catch sites are
     * unchanged; what is new is that the key, the file and the hint survive the
     * throw and can be recorded as values.</p>
     */
    public static final class WorkspaceScopeRefused extends IllegalArgumentException {

        private static final long serialVersionUID = 1L;

        private final String key;
        private final String file;
        private final String hint;
        private final Boolean inForce;
        private final String inForceFrom;

        /**
         * The pre-354 form: a refusal that took no reading of what it costs.
         * Kept so a caller outside the loader can still construct one without
         * claiming a measurement it did not make.
         *
         * @param key     the setting the scope was not allowed to name
         * @param file    the settings file it was read from
         * @param hint    where the setting does belong
         * @param message the whole sentence, unchanged from before card 285
         */
        public WorkspaceScopeRefused(String key, String file, String hint, String message) {
            this(key, file, hint, null, null, message);
        }

        /**
         * The card 354 form: the refusal plus the reading of what it costs.
         *
         * @param key         the setting the scope was not allowed to name
         * @param file        the settings file it was read from
         * @param hint        where the setting does belong
         * @param inForce     whether nothing this scope asked for is being
         *                    lost — every field it set is already carried, at
         *                    the same value, by an allowed layer; {@code null}
         *                    when no reading was taken
         * @param inForceFrom the allowed layer that carries the refused KEY —
         *                    non-null exactly when {@code inForce} is
         *                    {@code TRUE}
         * @param message     the whole sentence, unchanged from before card 285
         */
        public WorkspaceScopeRefused(String key, String file, String hint,
                Boolean inForce, String inForceFrom, String message) {
            super(message);
            this.key = key;
            this.file = file;
            this.hint = hint;
            this.inForce = inForce;
            this.inForceFrom = inForceFrom;
        }

        /** @return the setting the scope was not allowed to name */
        public String key() {
            return key;
        }

        /** @return the settings file it was read from */
        public String file() {
            return file;
        }

        /** @return where the setting does belong */
        public String hint() {
            return hint;
        }

        /**
         * Whether the refusal costs the operator anything.
         *
         * <p>Card 354. {@code TRUE} means dropping this file changes nothing:
         * every field it set — the refused key and its neighbours alike — is
         * already carried at the SAME value by a layer allowed to carry it. It
         * is a statement about the FILE because the refusal is: the throw leaves
         * on the first forbidden key and abandons the whole scope, so a reading
         * that answered only about that key would call a file free while an
         * ordinary setting beside it goes down unmentioned.</p>
         *
         * <p>{@code FALSE} means something in it is being lost — including the
         * case where an allowed layer names a key in order to set it the other
         * way, which is a loss and not a free pass. {@code null} means no
         * reading was taken, which is only ever true of a refusal recorded
         * before this card.</p>
         *
         * @return the reading, or {@code null} when none was taken
         */
        public Boolean inForce() {
            return inForce;
        }

        /** The allowed layer that carries the refused KEY — one of the
         *  {@link Origin} layer names ({@code "env"}, {@code "user"},
         *  {@code "launch-dir"}, {@code "flags"}). Non-null exactly when
         *  {@link #inForce()} is {@code TRUE}: with something in the file being
         *  lost there is no free pass to explain, and naming the layer that
         *  carries the OTHER value would send the operator to edit a file that
         *  is already doing what it says.
         *  @return the carrying layer, or {@code null} */
        public String inForceFrom() {
            return inForceFrom;
        }
    }

    /** A copy of this config with only the provider/model pair swapped — the
     *  mid-session switch derives configs HERE, never via the canonical ctor,
     *  so record growth cannot silently drop fields again.
     *  @param provider the new provider ("anthropic" | "ollama" | "openai")
     *  @param model    the new model, paired with {@code provider}
     *  @return a new config identical to this one except provider and model */
    public SpectroConfig withProvider(String provider, String model) {
        return new SpectroConfig(provider, model, baseUrl,
                compactionThreshold, permissionMode, autoApprove,
                imageProvider, thinking, mcpServers,
                maxRetries, promptCaching, hooks,
                workspace, logLevel, imageModel, sttModel, sttProvider, sttLanguage,
                chromeBinary, otlpEndpoint, otlpBasicAuth,
                ollamaBaseUrl, lmstudioBaseUrl, searxngUrl, allowLocalhost, headlessMcp,
                progressGuardWrites, progressGuardFailures, progressGuardPlanTurns,
                continuationBudget, maxTurns, llamacppBaseUrl,
                questionsPerRun, maxQuestionOptions, maxQuestionChars,
                commandTimeoutSeconds, chatReserveWidth, dockMaxWidth, maxTokens);
    }

    /** Whether {@code provider} is a selectable LLM backend — the single source
     *  shared by config validation and the live header-picker switch, so the two
     *  cannot drift apart. */
    public static boolean isKnownProvider(String provider) {
        return KNOWN_PROVIDERS.contains(provider);
    }

    /** Every selectable LLM backend. Exposed so a face that switches over the
     *  providers can be held to this list by a test rather than by whoever
     *  remembers to look: the doctor's reachability switch knew three of the
     *  seven for two releases and called the rest unknown (card 164).
     *  @return the known provider names; iteration order is not defined
     *          (use {@link #KNOWN_PROVIDERS_DISPLAY} for anything a human reads) */
    public static Set<String> knownProviders() {
        return KNOWN_PROVIDERS;
    }

    /** Every backend a newcomer can run for free on a machine they control —
     *  DERIVED from two facts each provider already declares, never typed out
     *  again: it needs no key ({@link #keyEnvFor} returns null) and it owns an
     *  address somebody dials ({@link #endpointFor} answers instead of
     *  refusing). The second half is what separates these from the bundled
     *  runtime, which is keyless too but is a subprocess, not a server.
     *
     *  <p>Exists so an onboarding screen can be HELD to this list instead of
     *  repeating it. Card 312 added a third member, and the CLI's first-run
     *  hint, the comment above its call site and the test under it all still
     *  said two — the test spelled the same pair out, so nothing could go
     *  red.</p>
     *
     *  @return the keyless local server providers; iteration order is not
     *          defined */
    public static Set<String> keylessLocalServers() {
        return Set.copyOf(KNOWN_PROVIDERS.stream()
                .filter(provider -> keyEnvFor(provider) == null)
                .filter(provider -> presetEndpointFor(provider) != null)
                .toList());
    }

    /** Every backend that speaks the OpenAI chat/completions wire — the same
     *  {@link #isOpenAiCompat} rule, handed out as a SET so a caller in another
     *  package can be held to it.
     *
     *  <p>Exists because {@code isOpenAiCompat} is package-private and the
     *  server's {@code /api/models} route is not in this package: its arm for
     *  these providers was therefore a hand-typed copy of the switch below,
     *  with a javadoc pointing at a symbol no test could reach. Measured on
     *  card 312, round 5 — a ninth provider added to {@link #KNOWN_PROVIDERS},
     *  {@link #endpointFor} and {@code isOpenAiCompat} and nowhere else left
     *  the whole spectro-server suite green while the picker showed an empty
     *  model list for a backend the config accepts and that speaks the wire.</p>
     *
     *  @return the OpenAI-compatible providers; iteration order is not
     *          defined */
    public static Set<String> openAiCompatProviders() {
        return Set.copyOf(KNOWN_PROVIDERS.stream()
                .filter(SpectroConfig::isOpenAiCompat)
                .toList());
    }

    /** The address {@code provider} is dialled at when nothing is configured —
     *  its own preset, taken from {@link #endpointFor} on the default config
     *  rather than by repeating that method's case list, so a preset that moves
     *  moves everywhere it is quoted. {@code null} for a provider that owns no
     *  address at all (anthropic's is fixed in the SDK; the bundled runtime is
     *  a subprocess).
     *  @param provider the provider name
     *  @return the preset endpoint, or null when the provider has none */
    public static String presetEndpointFor(String provider) {
        try {
            return DEFAULTS.endpointFor(provider);
        } catch (IllegalArgumentException noAddressToDial) {
            return null;
        }
    }

    /**
     * The default model for a provider when none is set explicitly, or {@code null}
     * when the provider has no honest default. A local backend serves whatever model
     * is loaded — lmstudio and the openai preset ignore the id — or a small default
     * (ollama), never the Claude id: that was the "opus for lmstudio" bug. anthropic
     * defaults to its real model; gemini and openrouter have NO baked default, so
     * they return null and the caller must obtain an explicit model rather than
     * fabricate a foreign id (a live switch to them would otherwise send a Claude id
     * to a non-Claude endpoint). Shared by boot resolution ({@link #finishResolve})
     * and a live provider switch, so a switch can never carry the previous model.
     */
    public static String defaultModelFor(String provider) {
        return switch (provider) {
            case "ollama" -> "qwen3";
            // llamacpp: the id is DECORATIVE. One llama-server serves the one
            // model it was started with and ignores the model field — measured
            // 2026-08-30 against b10107, where a request naming
            // "totally-made-up-name" completed normally and the response
            // echoed the actually loaded model.
            case "lmstudio", "llamacpp", "openai" -> "local-model";
            // Ask the catalogue rather than repeat it. This used to be a constant,
            // and it drifted: the catalogue moved its default to a model that
            // shows its thinking AND drives tools, while a live picker switch
            // kept starting the tool-free one with the research-only licence.
            case "spectro-local" -> dev.spectroscope.core.local.LocalCatalog.bundled().defaultId();
            case "anthropic" -> DEFAULTS.model(); // claude-opus-4-8, a real anthropic model
            default -> null; // gemini, openrouter: no baked default — the caller decides
        };
    }

    /** Whether a LIVE provider switch to {@code provider} requires an API key to be
     *  present. True for the cloud services that cannot work without one (anthropic,
     *  gemini, openrouter). False for every provider with no key variable AND for
     *  openai — openai is the generic OpenAI-compatible escape hatch, routinely
     *  pointed at a keyless local server via a custom base url, so a switch to it
     *  stays tolerant (its default-endpoint keyless gap is pre-existing and out of
     *  this method's scope). */
    public static boolean switchRequiresKey(String provider) {
        return keyEnvFor(provider) != null && !"openai".equals(provider);
    }

    /**
     * Fails loudly when a resolved field's value is outside its known set — a
     * typo must never silently disable what the user configured. The allowed-
     * value text is passed explicitly rather than derived from {@code known}'s
     * iteration order (which {@link Set#of} does not guarantee) so the message
     * stays byte-for-byte reproducible.
     *
     * @param field          human-readable field name for the message (e.g. "provider")
     * @param value          the resolved value to check
     * @param known          the valid values for this field
     * @param allowedDisplay the exact "(allowed: ...)" listing for the message
     * @throws IllegalArgumentException when {@code value} is not in {@code known}
     */
    private static void validateKnown(String field, String value, Set<String> known,
            String allowedDisplay) {
        if (!known.contains(value)) {
            throw new IllegalArgumentException(
                    "Unknown " + field + ": \"" + value + "\" (allowed: " + allowedDisplay + ")");
        }
    }

    /**
     * Converts the Claude-Desktop-shaped {@code mcpServers} object (keyed by
     * server name) into a name-carrying list, preserving declaration order.
     *
     * @param byName the parsed config object — keys are the server names
     * @return the same servers as an immutable list, each entry carrying its name
     */
    private static List<McpServerConfig> toServerList(Map<String, McpServerConfig> byName) {
        List<McpServerConfig> servers = new ArrayList<>();
        byName.forEach((name, entry) -> {
            McpServerConfig e = entry == null
                    ? new McpServerConfig(null, null, null, null, null, null) : entry;
            servers.add(new McpServerConfig(name, e.command(), e.args(), e.env(), e.url(), e.type(),
                    e.enabled()));
        });
        return List.copyOf(servers);
    }

    /** Accepts 1/0/true/false (case-insensitive); anything else is falsey.
     *  @param value the raw environment-variable string
     *  @return true only for "1" or "true" */
    private static boolean parseBool(String value) {
        String v = value.trim().toLowerCase(java.util.Locale.ROOT);
        return v.equals("1") || v.equals("true");
    }

    /** Malformed config fails loudly — but readably, not as a raw NumberFormatException.
     *  @param value the raw SPECTRO_MAX_RETRIES string
     *  @return the parsed retry count (0 disables retries) */
    private static int parseMaxRetries(String value) {
        try {
            return Integer.parseInt(value.trim());
        } catch (NumberFormatException bad) {
            throw new IllegalArgumentException(
                    "SPECTRO_MAX_RETRIES must be an integer, got: \"" + value + "\"");
        }
    }

    /**
     * Picks the {@link LlmProvider} implementation for this config and wraps it
     * in the transient-retry decorator — the single chokepoint every face goes
     * through (CLI, server, headless, and the mid-session provider switch). The
     * model lives in the provider constructor — the agent has no model option.
     *
     * @return the retry-wrapped provider, ready to hand to the agent
     */
    public LlmProvider providerFromConfig() {
        LlmProvider real = switch (provider) {
            case "ollama" -> new OllamaProvider(new OllamaOptions(endpointFor("ollama"), model));
            // "llamacpp" is NOT a new dialect stamp: the label already existed
            // inside OpenAiCompatProvider as the INFERRED name for a non-cloud
            // OpenAI-compatible base, and it already has its own row in
            // capabilities.json. Card 312 gives that existing dialect a front
            // door rather than spelling the same measured fact a second way.
            case "openai", "lmstudio", "llamacpp", "openrouter", "gemini" -> new OpenAiCompatProvider(
                    // The label rides along as the wire dialect — the reasoning
                    // fields differ per provider (card 88), nothing else does.
                    new OpenAiCompatProvider.Options(endpointFor(provider), model, openAiCompatKey(), provider));
            case "anthropic" -> new AnthropicProvider(model, promptCaching, resolveApiKey("ANTHROPIC_API_KEY"));
            case "spectro-local" -> throw new IllegalStateException(
                    "spectro-local runs through the bundled local runtime "
                    + "(dev.spectroscope.core.local.LocalProviderFactory), wired by the "
                    + "server/CLI — not the pure config path, which cannot start a subprocess");
            default -> throw new IllegalArgumentException("Unknown provider: " + provider);
        };
        // The autologging proxy sits around the CONCRETE provider,
        // INSIDE the retry decorator — so at DEBUG every retry attempt shows as
        // its own entry/exit pair. Silent below DEBUG.
        LlmProvider logged = dev.spectroscope.core.log.Logged.wrap(LlmProvider.class, real);
        return RetryingProvider.wrap(logged, RetryPolicy.from(maxRetries));
    }

    /**
     * The EFFECTIVE endpoint for an OpenAI-compatible provider, static and pure
     * for tests: an explicit baseUrl always wins; otherwise the provider's own
     * preset. No key-based swapping — the provider names the endpoint, the key
     * only authenticates. The provider, {@link #providerHost()} and the server's
     * live model list all derive from this one rule.
     *
     * @param provider an OpenAI-compatible provider — a member of
     *                 {@link #openAiCompatProviders()}, named by the rule rather
     *                 than retyped here: the three that stood in this line
     *                 shipped while {@link #endpointFor} was already passing
     *                 gemini in (card 312)
     * @param baseUrl  the configured base url
     * @return the endpoint the openai-compatible provider talks to
     */
    public static String effectiveOpenAiBaseUrl(String provider, String baseUrl) {
        if (!"http://localhost:11434".equals(baseUrl)) {
            return baseUrl; // an explicit endpoint always wins
        }
        return openAiCompatPreset(provider);
    }

    /**
     * The effective ollama endpoint (card 193): the per-provider address when
     * set, the legacy shared {@code baseUrl} otherwise, ollama's preset when
     * neither says anything. Deliberately NO sentinel on the per-provider
     * field — any non-blank value is taken verbatim, even one that equals some
     * provider's preset. The legacy field's literal
     * {@code http://localhost:11434} doubling as "unset" is exactly the trap
     * this card closes: a deliberately typed default must never be silently
     * rerouted.
     *
     * @param ollamaBaseUrl the per-provider address ({@code null}/blank = unset)
     * @param baseUrl       the legacy shared base url, kept working for old configs
     * @return the endpoint ollama is dialled at
     */
    public static String effectiveOllamaBaseUrl(String ollamaBaseUrl, String baseUrl) {
        if (ollamaBaseUrl != null && !ollamaBaseUrl.isBlank()) {
            return ollamaBaseUrl;
        }
        if (baseUrl != null && !baseUrl.isBlank()) {
            return baseUrl;
        }
        return "http://localhost:11434";
    }

    /**
     * The effective LM Studio endpoint (card 193): the per-provider address
     * when set — verbatim, no sentinel, see {@link #effectiveOllamaBaseUrl} —
     * otherwise the legacy openai-compat rule over the shared {@code baseUrl}
     * (where ollama's default DOES still read as "unset", for old configs).
     *
     * @param lmstudioBaseUrl the per-provider address ({@code null}/blank = unset)
     * @param baseUrl         the legacy shared base url, kept working for old configs
     * @return the endpoint LM Studio is dialled at
     */
    public static String effectiveLmstudioBaseUrl(String lmstudioBaseUrl, String baseUrl) {
        if (lmstudioBaseUrl != null && !lmstudioBaseUrl.isBlank()) {
            return lmstudioBaseUrl;
        }
        if (baseUrl == null || baseUrl.isBlank()) {
            return openAiCompatPreset("lmstudio");
        }
        return effectiveOpenAiBaseUrl("lmstudio", baseUrl);
    }

    /**
     * The base URL this config would dial for {@code provider} — the single
     * source behind the provider construction, the server's model-list probes,
     * the doctor lines and the settings page's address display, so every face
     * names the SAME address (card 193: the failure sentence must name the
     * address the probe actually tried). The local-model providers resolve
     * their own per-provider field first; the OpenAI-compatible cloud
     * providers keep the legacy shared rule.
     *
     * @param provider a provider with a configurable endpoint — the arms below
     * @return the effective endpoint for {@code provider} under this config
     * @throws IllegalArgumentException for providers without a configurable
     *         endpoint (anthropic's is fixed in the SDK; spectro-local is a
     *         subprocess, not an address)
     */
    public String endpointFor(String provider) {
        return switch (provider) {
            case "ollama" -> effectiveOllamaBaseUrl(ollamaBaseUrl, baseUrl);
            case "lmstudio" -> effectiveLmstudioBaseUrl(lmstudioBaseUrl, baseUrl);
            case "llamacpp" -> effectiveLlamacppBaseUrl(llamacppBaseUrl, baseUrl);
            case "openai", "openrouter", "gemini" -> effectiveOpenAiBaseUrl(provider, baseUrl);
            default -> throw new IllegalArgumentException(
                    "no configurable endpoint for provider: " + provider);
        };
    }

    /**
     * The effective llama.cpp endpoint (card 312): the per-provider address when
     * set — verbatim, no sentinel, see {@link #effectiveOllamaBaseUrl} — then the
     * legacy shared {@code baseUrl}, then llama-server's own documented default
     * port. The legacy field's literal {@code http://localhost:11434} is ollama's
     * port doubling as "unset", so it is skipped here exactly as the other
     * per-provider rules skip it.
     *
     * @param llamacppBaseUrl the per-provider address ({@code null}/blank = unset)
     * @param baseUrl         the legacy shared base url, kept working for old configs
     * @return the endpoint the llama.cpp server is dialled at
     */
    public static String effectiveLlamacppBaseUrl(String llamacppBaseUrl, String baseUrl) {
        if (llamacppBaseUrl != null && !llamacppBaseUrl.isBlank()) {
            return llamacppBaseUrl;
        }
        if (baseUrl != null && !baseUrl.isBlank()
                && !"http://localhost:11434".equals(baseUrl)) {
            return baseUrl;
        }
        return openAiCompatPreset("llamacpp");
    }

    /** The preset endpoint root for each OpenAI-compatible provider, before any
     *  explicit override — the arms below ARE the list, so reading them is
     *  cheaper than a second copy up here that can lose one (this one had lost
     *  gemini). Two of them address a server on the reader's own machine; the
     *  rest are somebody's cloud.
     *  @param provider the provider name
     *  @return the preset base URL */
    static String openAiCompatPreset(String provider) {
        return switch (provider) {
            case "lmstudio" -> "http://localhost:1234";
            // llama-server's own default, from the bundled binary's help text:
            // `--port PORT  port to listen (default: 8080)` (build b10107).
            case "llamacpp" -> "http://localhost:8080";
            case "openrouter" -> "https://openrouter.ai/api";
            case "gemini" -> "https://generativelanguage.googleapis.com/v1beta/openai";
            default -> "https://api.openai.com";
        };
    }

    /** True for the OpenAI-compatible providers — one wire protocol, as many
     *  hosts as the arms below. It said "three hosts" over five of them, and
     *  the sentence had already been copied into the guide's wire chapter,
     *  where card 312 corrected the copy and left this original standing.
     *  @param provider the provider name
     *  @return whether it speaks the OpenAI chat/completions API */
    static boolean isOpenAiCompat(String provider) {
        return "openai".equals(provider)
                || "lmstudio".equals(provider)
                || "llamacpp".equals(provider)
                || "openrouter".equals(provider)
                || "gemini".equals(provider);
    }

    /** The environment variable carrying a provider's API key, or {@code null}
     *  for the local backends that authenticate with nothing (the {@code default}
     *  arm below, which is what {@link #keylessLocalServers} is filtered on).
     *  The single source for both the provider construction and the onboarding
     *  status the faces show.
     *  @param provider the provider name
     *  @return the key env var name, or null when the provider is local */
    public static String keyEnvFor(String provider) {
        return switch (provider) {
            case "anthropic" -> "ANTHROPIC_API_KEY";
            case "openai" -> "OPENAI_API_KEY";
            case "openrouter" -> "OPENROUTER_API_KEY";
            case "gemini" -> "GEMINI_API_KEY"; // same key as the gemini image backend
            default -> null; // the local backends: no key to carry
        };
    }

    /** The environment variable carrying a WEB SEARCH provider's API key, or
     *  {@code null} for anything that is not one. Deliberately a second
     *  vocabulary rather than an entry in {@link #keyEnvFor}: those names are
     *  LLM backends, and a search provider that answered
     *  {@link #onboardingStatus} or {@link #isKnownProvider} would be offered
     *  in the model picker as a place to run a conversation.
     *  <p>Shares one thing with its sibling on purpose — the 0600 write in
     *  {@link #writeApiKey} — so a Tavily or Brave key saved from the settings
     *  page lands exactly where every other key already does.</p>
     *  @param provider the search provider name ("tavily" or "brave")
     *  @return the key env var name, or null when it is not a keyed search provider */
    public static String searchKeyEnvFor(String provider) {
        return switch (provider == null ? "" : provider) {
            case "tavily" -> "TAVILY_API_KEY";
            case "brave" -> "BRAVE_API_KEY";
            default -> null;
        };
    }

    /** A provider's onboarding status for the first-run dialog and the picker:
     *  an API provider is {@code "ready"} once its key is present and
     *  {@code "needs-key"} otherwise; a provider with no key variable is
     *  {@code "local"} — its readiness is a reachability question the live model
     *  list answers, not a key check.
     *  @param provider   the provider name
     *  @param keyPresent whether {@link #keyEnvFor} is set and non-blank
     *  @return "ready" | "needs-key" | "local" */
    public static String onboardingStatus(String provider, boolean keyPresent) {
        return keyEnvFor(provider) == null ? "local" : (keyPresent ? "ready" : "needs-key");
    }

    /** {@link #onboardingStatus} for a provider talking to a CONCRETE endpoint —
     *  the same three words, one fact richer. A key variable says a provider CAN
     *  need a key, not that this endpoint does: {@code openai} is the generic
     *  OpenAI-compatible escape hatch and is routinely pointed at a keyless
     *  server on the operator's own machine (see {@link #switchRequiresKey}).
     *  Against such an endpoint the answer is {@code "local"}, exactly as for a
     *  provider that has no key variable at all; against a public service a
     *  missing key is {@code "needs-key"} and nothing about it is healthy.
     *  @param provider   the provider name
     *  @param endpoint   the effective base url it will dial
     *  @param keyPresent whether {@link #keyEnvFor} is set and non-blank
     *  @return "ready" | "needs-key" | "local" */
    public static String onboardingStatusAt(String provider, String endpoint, boolean keyPresent) {
        if (isLocalEndpoint(endpoint)) {
            return "local";
        }
        return onboardingStatus(provider, keyPresent);
    }

    /** Whether a base url names a server on the operator's own machine or private
     *  network rather than a public service — loopback, a private IPv4 range, or
     *  a {@code localhost}/{@code .local} name. Deliberately narrow: everything
     *  it does not recognise counts as public, so an unknown host errs towards
     *  asking for the key rather than towards a green light.
     *  <p>Public because the doctor line has to know WHICH road reached the
     *  "local" verdict: a keyless provider called against a public endpoint is
     *  also "local", and telling that reader the endpoint sits on their own
     *  machine is a false statement about their network.</p>
     *  @param url the base url, may be null or unparsable
     *  @return true when the host is loopback, private, or a local name */
    public static boolean isLocalEndpoint(String url) {
        if (url == null || url.isBlank()) {
            return false;
        }
        String host;
        try {
            host = java.net.URI.create(url.trim()).getHost();
        } catch (IllegalArgumentException notAUrl) {
            return false;
        }
        if (host == null) {
            return false;
        }
        host = host.toLowerCase(java.util.Locale.ROOT).replace("[", "").replace("]", "");
        if (host.equals("localhost") || host.endsWith(".localhost") || host.endsWith(".local")
                || host.equals("::1") || host.equals("0.0.0.0")) {
            return true;
        }
        // A private range is a range of ADDRESSES, so the host has to BE an
        // address before its octets mean anything. Matching the string prefix
        // instead handed the private verdict to any name that merely started
        // that way: 10.example.com, 192.168.example.com and 172.16.example.com
        // are public DNS names and all three were read as the operator's own
        // network, which is the opposite of this method's stated bias.
        return isPrivateIpv4(host);
    }

    /** Whether a host is literally a private-range IPv4 address.
     *  @param host the lower-cased host, brackets already stripped
     *  @return true for 127/8, 10/8, 192.168/16 and 172.16/12 */
    private static boolean isPrivateIpv4(String host) {
        String[] octets = host.split("\\.");
        if (octets.length != 4) {
            return false;
        }
        int[] parts = new int[4];
        for (int i = 0; i < 4; i++) {
            if (octets[i].isEmpty() || octets[i].length() > 3) {
                return false;
            }
            for (int c = 0; c < octets[i].length(); c++) {
                if (octets[i].charAt(c) < '0' || octets[i].charAt(c) > '9') {
                    return false; // a label with a letter in it is a name, not an address
                }
            }
            parts[i] = Integer.parseInt(octets[i]);
            if (parts[i] > 255) {
                return false;
            }
        }
        return parts[0] == 127
                || parts[0] == 10
                || (parts[0] == 192 && parts[1] == 168)
                || (parts[0] == 172 && parts[1] >= 16 && parts[1] <= 31);
    }

    /** The built-in local provider's picker status: {@code "ready"} once the
     *  model file is present, else {@code "needs-download"} — the lean DMG's
     *  first-run modal fills it. Unlike {@link #onboardingStatus}'s {@code
     *  "local"} (a reachability question), a bundled model's readiness is a
     *  file-presence fact the server can answer directly.
     *  @param modelPresent whether the GGUF resolves (bundle or user models dir)
     *  @return "ready" | "needs-download" */
    public static String localModelStatus(boolean modelPresent) {
        return modelPresent ? "ready" : "needs-download";
    }

    /** {@code ~/.spectro/.env} — where the UI's "save key" writes API keys, read
     *  back as a fallback to the process environment. User-scoped so it works the
     *  same from the jar, the launcher and the desktop app.
     *  @return the path (the file may not exist) */
    public static Path dotEnvPath() {
        return Path.of(System.getProperty("user.home"), ".spectro", ".env");
    }

    /** Resolve an API key: the process environment first (a real env var or a
     *  launcher-loaded ./.env always wins), then {@link #dotEnvPath()}. A running
     *  JVM cannot change its own {@code System.getenv}, so this file fallback is
     *  what lets a key saved from the UI take effect on the next provider build.
     *  @param keyEnv the env var name (e.g. ANTHROPIC_API_KEY), or null
     *  @return the key value, or null when set nowhere */
    public static String resolveApiKey(String keyEnv) {
        if (keyEnv == null) {
            return null;
        }
        String env = System.getenv(keyEnv);
        if (env != null && !env.isBlank()) {
            return env;
        }
        return dotEnvValue(keyEnv);
    }

    /** Presence of an API key across env and {@link #dotEnvPath()} — never the value.
     *  @param keyEnv the env var name, or null
     *  @return true when set and non-blank somewhere */
    public static boolean hasApiKey(String keyEnv) {
        String v = resolveApiKey(keyEnv);
        return v != null && !v.isBlank();
    }

    /** Image-provider API keys the image subsystem may need — kept next to
     *  {@link #imageEnv()} so a new image backend adds its key here. */
    private static final java.util.List<String> IMAGE_KEY_ENVS =
            java.util.List.of("GEMINI_API_KEY", "OPENAI_API_KEY");

    /** The environment the image subsystem builds its provider from: the process
     *  environment, overlaid with any image key the UI wrote to {@link #dotEnvPath()}
     *  (so 'set key in UI' feeds image generation, not only chat). The process env
     *  wins when it already carries the key — same precedence as {@link #resolveApiKey}. */
    public static java.util.Map<String, String> imageEnv() {
        return imageEnvFrom(System.getenv());
    }

    /** {@link #imageEnv()} over an injectable base environment (for tests). A
     *  process var that is absent OR blank counts as unset — same as
     *  {@link #resolveApiKey} — so a UI-saved {@link #dotEnvPath()} key still
     *  surfaces (a blank {@code GEMINI_API_KEY=} must not shadow it). */
    static java.util.Map<String, String> imageEnvFrom(java.util.Map<String, String> base) {
        java.util.Map<String, String> env = new java.util.HashMap<>(base);
        for (String keyEnv : IMAGE_KEY_ENVS) {
            String existing = env.get(keyEnv);
            if (existing == null || existing.isBlank()) {
                String fromDotEnv = dotEnvValue(keyEnv);
                if (fromDotEnv != null && !fromDotEnv.isBlank()) {
                    env.put(keyEnv, fromDotEnv);
                }
            }
        }
        return env;
    }

    /** One key's value from {@link #dotEnvPath()} (KEY=value; one layer of quotes
     *  stripped), or null. */
    private static String dotEnvValue(String keyEnv) {
        Path env = dotEnvPath();
        if (!Files.exists(env)) {
            return null;
        }
        try {
            for (String line : Files.readAllLines(env)) {
                String t = line.strip();
                int eq = t.indexOf('=');
                if (t.isEmpty() || t.startsWith("#") || eq < 1) {
                    continue;
                }
                if (!t.substring(0, eq).strip().equals(keyEnv)) {
                    continue;
                }
                String v = t.substring(eq + 1).strip();
                if (v.length() >= 2
                        && ((v.startsWith("\"") && v.endsWith("\"")) || (v.startsWith("'") && v.endsWith("'")))) {
                    v = v.substring(1, v.length() - 1);
                }
                return v.isBlank() ? null : v;
            }
        } catch (IOException unreadable) {
            return null;
        }
        return null;
    }

    /** Upsert an API key into {@link #dotEnvPath()} (0600) — the write half of the
     *  UI "save key". The caller validates {@code keyEnv} against {@link #keyEnvFor}.
     *  @param keyEnv the env var name
     *  @param value  the secret (never logged)
     *  @throws IOException if the file cannot be written */
    public static void writeApiKey(String keyEnv, String value) throws IOException {
        Path env = dotEnvPath();
        Files.createDirectories(env.getParent());
        List<String> lines = Files.exists(env) ? new ArrayList<>(Files.readAllLines(env)) : new ArrayList<>();
        lines.removeIf(l -> l.strip().startsWith(keyEnv + "="));
        lines.add(keyEnv + "=" + value);
        Files.write(env, lines);
        try {
            Files.setPosixFilePermissions(env, PosixFilePermissions.fromString("rw-------"));
        } catch (UnsupportedOperationException | IOException nonPosix) {
            // Windows / non-POSIX: best effort — the file stays under the user's home.
        }
    }

    /** This provider's API key from the environment — {@code OPENROUTER_API_KEY}
     *  for openrouter, {@code OPENAI_API_KEY} otherwise (LM Studio ignores it).
     *  @return the key, or null when unset */
    private String openAiCompatKey() {
        return resolveApiKey(keyEnvFor(provider)); // null keyEnv (a local backend) -> no key
    }

    /**
     * The network host the active provider actually talks to — presentation
     * truth for the UI (header chip, trace host column, provider_info frame):
     * the Anthropic SDK's fixed endpoint, or the host[:port] of the EFFECTIVE
     * base URL for the local backends (per-provider address included, card
     * 193). An unparseable base URL degrades to the raw value.
     *
     * @return e.g. "api.anthropic.com", "localhost:11434", "localhost:1234"
     */
    public String providerHost() {
        if ("anthropic".equals(provider)) {
            return "api.anthropic.com";
        }
        String effective = isOpenAiCompat(provider) || "ollama".equals(provider)
                ? endpointFor(provider) : baseUrl;
        try {
            java.net.URI url = java.net.URI.create(effective);
            String host = url.getHost();
            if (host == null) {
                return effective;
            }
            return url.getPort() == -1 ? host : host + ":" + url.getPort();
        } catch (RuntimeException invalid) {
            return effective;
        }
    }

    /**
     * Builds the {@link dev.spectroscope.core.image.ImageProvider} for this config.
     * Throws {@link IllegalStateException} when the provider's API key is missing —
     * callers behind the generate_image tool turn that into an {@code ERROR:} string.
     * {@code imageModel} (settings hierarchy, env {@code SPECTRO_IMAGE_MODEL}) overrides
     * the provider's default model.
     *
     * @return the image backend named by {@code imageProvider} ("gemini" or "openai")
     */
    public dev.spectroscope.core.image.ImageProvider imageProviderFromConfig() {
        return dev.spectroscope.core.image.ImageProviders.create(imageProvider, imageModel, imageEnv());
    }

    /** The env map for Chrome discovery: the process env, with the configured
     *  chromeBinary overlaid as SPECTRO_CHROME so BrowsePageTool needs no new seam. */
    public Map<String, String> chromeEnv() {
        if (chromeBinary == null || chromeBinary.isBlank()) {
            return System.getenv();
        }
        Map<String, String> overlay = new HashMap<>(System.getenv());
        overlay.put("SPECTRO_CHROME", chromeBinary);
        return overlay;
    }

    /**
     * SPECTRO.md from the working directory — its content is appended to the
     * system prompt. The legacy name FORGE.md is still read when SPECTRO.md is
     * absent, so pre-rename workspaces keep working (de-brand leftover, closed
     * in migration phase 6 docs work). Returns an empty string when neither
     * file exists. Provider-neutral: it reaches every provider via
     * {@code ProviderRequest.system}.
     *
     * @param cwd the working directory searched for SPECTRO.md (then FORGE.md)
     * @return the ready-to-append prompt section, or "" when no file is present
     */
    public static String loadProjectMd(Path cwd) {
        for (String name : new String[] {"SPECTRO.md", "FORGE.md"}) {
            Path file = cwd.resolve(name);
            try {
                String content = Files.readString(file, StandardCharsets.UTF_8).strip();
                return "\n\n## Project context (" + name + ")\n\n" + content;
            } catch (IOException absent) {
                // fall through to the legacy name
            }
        }
        return "";
    }

    /**
     * AGENTS.md from the agent's WORKSPACE — the emerging cross-tool
     * agent-instructions convention, read from where the agent actually works
     * (its workspace, next to the code it edits), and appended to the system
     * prompt. This is a different scope than {@link #loadProjectMd(Path)}:
     * SPECTRO.md carries spectroscope's own project context from the project
     * root, AGENTS.md carries the workspace's agent house-rules. Both append
     * when present; neither shadows the other. A {@code null} or AGENTS.md-less
     * workspace yields an empty string. Provider-neutral, like SPECTRO.md.
     *
     * @param workspace the agent's working directory searched for AGENTS.md
     *                  (may be {@code null} when no workspace is resolved yet)
     * @return the ready-to-append prompt section, or "" when no file is present
     */
    public static String loadAgentsMd(Path workspace) {
        if (workspace == null) {
            return "";
        }
        Path file = workspace.resolve("AGENTS.md");
        try {
            String content = Files.readString(file, StandardCharsets.UTF_8).strip();
            return "\n\n## Agent instructions (AGENTS.md)\n\n" + content;
        } catch (IOException absent) {
            return "";
        }
    }

    /** Reads one layer into a partial holder, or an all-null holder if absent.
     *  Only genuine file-absence (the file itself missing, or a parent
     *  directory that does not exist — both surface as {@link
     *  java.nio.file.NoSuchFileException}) is "absent"; a file that EXISTS but
     *  fails to parse is a broken config and fails loudly, naming the file and
     *  the parse problem, matching this class's own javadoc ("malformed JSON
     *  fails loudly on purpose — a broken config is a programming error, not
     *  something to silently ignore") — the pre-fix code caught IOException
     *  wholesale here, so a typo'd settings file silently loaded as an EMPTY
     *  layer instead.
     *  @param path the layer's JSON file (user config or project settings)
     *  @return the parsed partial; all fields null when the file does not exist
     *  @throws IllegalArgumentException when the file exists but is not valid
     *          JSON for this shape */
    private static PartialConfig readFile(Path path) {
        String raw;
        try {
            raw = Files.readString(path, StandardCharsets.UTF_8);
        } catch (java.nio.file.NoSuchFileException absent) {
            return new PartialConfig(); // layer absent — all fields null
        } catch (IOException unreadable) {
            // Anything else reading the file (permissions, a directory sitting
            // where a file is expected, …) is not a JSON parse problem — treated
            // the same as absent, exactly like before this fix.
            return new PartialConfig();
        }
        try {
            // Parsing a String (not a stream) can only ever fail with a JSON
            // parse problem — readValue(String, Class) never touches real I/O,
            // so JsonProcessingException is the only checked exception in play.
            return JSON.readValue(raw, PartialConfig.class);
        } catch (com.fasterxml.jackson.core.JsonProcessingException malformed) {
            throw new IllegalArgumentException(
                    "malformed settings file " + path + ": " + malformed.getOriginalMessage(), malformed);
        }
    }

    /**
     * Jackson holder with nullable fields: distinguishes "absent in the file" (null)
     * from "explicitly set". Not every layer comes from a JSON file — {@code fromEnv}
     * and {@code fromOverrides} synthesize the same sparse shape from the environment
     * and the CLI flags, so every layer (file or not) folds through the identical
     * {@code overriddenBy} chain. Layers compose with overriddenBy(); merged() fills
     * the remaining gaps from DEFAULTS.
     *
     * <p>ignoreUnknown: the same config.json also carries the CLI-side {@code tts}
     * block (read by {@code dev.spectroscope.cli.speech.TtsConfig}). The core ignores
     * it here so one file serves both — and so a new field added by either edition
     * never breaks config loading (the project's additive-compatibility rule).</p>
     *
     * <p>NON_NULL: {@link #loadResolved}'s layers view serializes a scope's
     * partial straight out (see {@link Resolved#layers()}) — sparse output
     * (only the fields that scope actually set) is what makes an all-null
     * partial serialize as {@code {}}, so an empty scope reads as absent
     * rather than as a wall of {@code null}s. Deserialization (reading a
     * settings file) is unaffected — this only shapes output.</p>
     *
     * <p>Package-private (not private): {@link SettingsWriter#patch} binds a
     * patched settings tree against this same shape before ever writing it —
     * the one place a settings file's value validation is answered, so a
     * write can never brick what {@link #load} later reads.</p>
     */
    @JsonIgnoreProperties(ignoreUnknown = true)
    @JsonInclude(JsonInclude.Include.NON_NULL)
    static final class PartialConfig {
        public String provider;
        public String model;
        public String baseUrl;
        public Integer compactionThreshold;
        public String permissionMode;
        public List<String> autoApprove;
        public String imageProvider;
        public Boolean thinking;
        public Integer maxRetries;
        public Boolean promptCaching;
        public String workspace;
        public String logLevel;
        public String imageModel;
        public String sttModel;
        public String sttProvider;
        public String sttLanguage;
        public String chromeBinary;
        public String otlpEndpoint;
        public String otlpBasicAuth;
        public String ollamaBaseUrl;
        public String lmstudioBaseUrl;
        /** llama.cpp's own address, card 312. */
        public String llamacppBaseUrl;
        public String searxngUrl;
        public Boolean allowLocalhost;
        public Boolean headlessMcp;
        // Card 262: three counts, and zero is the off switch for each — one knob
        // per detector rather than a knob and a flag that can disagree.
        public Integer progressGuardWrites;
        public Integer progressGuardFailures;
        public Integer progressGuardPlanTurns;
        // Card 266: how many times one run may be restarted; zero is off.
        public Integer continuationBudget;
        // Card 282: the runaway-loop brake, in turns per run.
        public Integer maxTurns;
        // Card 356: the three ask caps card 265 shipped as constants.
        public Integer questionsPerRun;
        public Integer maxQuestionOptions;
        public Integer maxQuestionChars;
        // Card 359: the wall-clock budget one run_command call gets.
        public Integer commandTimeoutSeconds;
        // Card 361: the two dock widths, in CSS pixels.
        public Integer chatReserveWidth;
        public Integer dockMaxWidth;
        // Card 364: the completion budget one provider call may spend.
        public Integer maxTokens;
        // Jackson deserializes the Claude-Desktop-shaped object here; the key is the
        // server name (folded in by toServerList). LinkedHashMap preserves order.
        // A layer that defines mcpServers replaces the whole block below it — the
        // block is treated as one unit in overriddenBy (no deep per-server merge).
        public LinkedHashMap<String, McpServerConfig> mcpServers;
        // Hooks are a plain array (event/matcher/command). A layer that defines
        // hooks replaces the whole block below it — whole-block merge, like mcpServers.
        public List<HookConfig> hooks;

        /** This layer overridden by a higher-priority one (project over user).
         *  @param higher the layer that wins wherever it defines a field
         *  @return a new partial — higher's fields where set, this layer's otherwise */
        PartialConfig overriddenBy(PartialConfig higher) {
            PartialConfig out = new PartialConfig();
            out.provider = Optional.ofNullable(higher.provider).orElse(provider);
            out.model = Optional.ofNullable(higher.model).orElse(model);
            out.baseUrl = Optional.ofNullable(higher.baseUrl).orElse(baseUrl);
            out.compactionThreshold =
                    Optional.ofNullable(higher.compactionThreshold).orElse(compactionThreshold);
            out.permissionMode = Optional.ofNullable(higher.permissionMode).orElse(permissionMode);
            out.autoApprove = Optional.ofNullable(higher.autoApprove).orElse(autoApprove);
            out.imageProvider = Optional.ofNullable(higher.imageProvider).orElse(imageProvider);
            out.thinking = Optional.ofNullable(higher.thinking).orElse(thinking);
            out.maxRetries = Optional.ofNullable(higher.maxRetries).orElse(maxRetries);
            out.promptCaching = Optional.ofNullable(higher.promptCaching).orElse(promptCaching);
            out.workspace = Optional.ofNullable(higher.workspace).orElse(workspace);
            out.logLevel = Optional.ofNullable(higher.logLevel).orElse(logLevel);
            out.imageModel = Optional.ofNullable(higher.imageModel).orElse(imageModel);
            out.sttModel = Optional.ofNullable(higher.sttModel).orElse(sttModel);
            out.sttProvider = Optional.ofNullable(higher.sttProvider).orElse(sttProvider);
            out.sttLanguage = Optional.ofNullable(higher.sttLanguage).orElse(sttLanguage);
            out.chromeBinary = Optional.ofNullable(higher.chromeBinary).orElse(chromeBinary);
            out.otlpEndpoint = Optional.ofNullable(higher.otlpEndpoint).orElse(otlpEndpoint);
            out.otlpBasicAuth = Optional.ofNullable(higher.otlpBasicAuth).orElse(otlpBasicAuth);
            out.ollamaBaseUrl = Optional.ofNullable(higher.ollamaBaseUrl).orElse(ollamaBaseUrl);
            out.lmstudioBaseUrl = Optional.ofNullable(higher.lmstudioBaseUrl).orElse(lmstudioBaseUrl);
            out.llamacppBaseUrl = Optional.ofNullable(higher.llamacppBaseUrl).orElse(llamacppBaseUrl);
            out.searxngUrl = Optional.ofNullable(higher.searxngUrl).orElse(searxngUrl);
            out.allowLocalhost = Optional.ofNullable(higher.allowLocalhost).orElse(allowLocalhost);
            out.headlessMcp = Optional.ofNullable(higher.headlessMcp).orElse(headlessMcp);
            out.progressGuardWrites =
                    Optional.ofNullable(higher.progressGuardWrites).orElse(progressGuardWrites);
            out.progressGuardFailures =
                    Optional.ofNullable(higher.progressGuardFailures).orElse(progressGuardFailures);
            out.progressGuardPlanTurns =
                    Optional.ofNullable(higher.progressGuardPlanTurns).orElse(progressGuardPlanTurns);
            out.continuationBudget =
                    Optional.ofNullable(higher.continuationBudget).orElse(continuationBudget);
            out.maxTurns = Optional.ofNullable(higher.maxTurns).orElse(maxTurns);
            out.questionsPerRun =
                    Optional.ofNullable(higher.questionsPerRun).orElse(questionsPerRun);
            out.maxQuestionOptions =
                    Optional.ofNullable(higher.maxQuestionOptions).orElse(maxQuestionOptions);
            out.maxQuestionChars =
                    Optional.ofNullable(higher.maxQuestionChars).orElse(maxQuestionChars);
            out.commandTimeoutSeconds = Optional.ofNullable(higher.commandTimeoutSeconds)
                    .orElse(commandTimeoutSeconds);
            out.chatReserveWidth =
                    Optional.ofNullable(higher.chatReserveWidth).orElse(chatReserveWidth);
            out.dockMaxWidth = Optional.ofNullable(higher.dockMaxWidth).orElse(dockMaxWidth);
            out.maxTokens = Optional.ofNullable(higher.maxTokens).orElse(maxTokens);
            // Whole-block replacement: the higher layer's mcpServers, if it defines one
            // at all, replaces this layer's block wholesale.
            out.mcpServers = Optional.ofNullable(higher.mcpServers).orElse(mcpServers);
            out.hooks = Optional.ofNullable(higher.hooks).orElse(hooks);
            return out;
        }

        /** Fills every remaining gap from DEFAULTS — the end of the layer chain.
         *  @return the complete, non-partial configuration */
        SpectroConfig merged() {
            return new SpectroConfig(
                    Optional.ofNullable(provider).orElse(DEFAULTS.provider()),
                    Optional.ofNullable(model).orElse(DEFAULTS.model()),
                    Optional.ofNullable(baseUrl).orElse(DEFAULTS.baseUrl()),
                    // Card 263: DEFAULTS holds null here, so an unset threshold
                    // stays unset and the harness derives it. Written as the same
                    // fold as every sibling field on purpose — the version that
                    // returned `compactionThreshold` directly made the DEFAULTS
                    // entry dead, and a dead default is one a later hand restores
                    // to 100_000 without a single test going red.
                    Optional.ofNullable(compactionThreshold).orElse(DEFAULTS.compactionThreshold()),
                    Optional.ofNullable(permissionMode).orElse(DEFAULTS.permissionMode()),
                    Optional.ofNullable(autoApprove).orElse(DEFAULTS.autoApprove()),
                    Optional.ofNullable(imageProvider).orElse(DEFAULTS.imageProvider()),
                    Optional.ofNullable(thinking).orElse(DEFAULTS.thinking()),
                    mcpServers == null ? DEFAULTS.mcpServers() : toServerList(mcpServers),
                    Optional.ofNullable(maxRetries).orElse(DEFAULTS.maxRetries()),
                    Optional.ofNullable(promptCaching).orElse(DEFAULTS.promptCaching()),
                    Optional.ofNullable(hooks).orElse(DEFAULTS.hooks()),
                    Optional.ofNullable(workspace).orElse(DEFAULTS.workspace()),
                    Optional.ofNullable(logLevel).orElse(DEFAULTS.logLevel()),
                    Optional.ofNullable(imageModel).orElse(DEFAULTS.imageModel()),
                    Optional.ofNullable(sttModel).orElse(DEFAULTS.sttModel()),
                    Optional.ofNullable(sttProvider).orElse(DEFAULTS.sttProvider()),
                    Optional.ofNullable(sttLanguage).orElse(DEFAULTS.sttLanguage()),
                    Optional.ofNullable(chromeBinary).orElse(DEFAULTS.chromeBinary()),
                    Optional.ofNullable(otlpEndpoint).orElse(DEFAULTS.otlpEndpoint()),
                    Optional.ofNullable(otlpBasicAuth).orElse(DEFAULTS.otlpBasicAuth()),
                    Optional.ofNullable(ollamaBaseUrl).orElse(DEFAULTS.ollamaBaseUrl()),
                    Optional.ofNullable(lmstudioBaseUrl).orElse(DEFAULTS.lmstudioBaseUrl()),
                    Optional.ofNullable(searxngUrl).orElse(DEFAULTS.searxngUrl()),
                    Optional.ofNullable(allowLocalhost).orElse(DEFAULTS.allowLocalhost()),
                    Optional.ofNullable(headlessMcp).orElse(DEFAULTS.headlessMcp()),
                    Optional.ofNullable(progressGuardWrites).orElse(DEFAULTS.progressGuardWrites()),
                    Optional.ofNullable(progressGuardFailures).orElse(DEFAULTS.progressGuardFailures()),
                    Optional.ofNullable(progressGuardPlanTurns).orElse(DEFAULTS.progressGuardPlanTurns()),
                    Optional.ofNullable(continuationBudget).orElse(DEFAULTS.continuationBudget()),
                    Optional.ofNullable(maxTurns).orElse(DEFAULTS.maxTurns()),
                    Optional.ofNullable(llamacppBaseUrl).orElse(DEFAULTS.llamacppBaseUrl()),
                    Optional.ofNullable(questionsPerRun).orElse(DEFAULTS.questionsPerRun()),
                    Optional.ofNullable(maxQuestionOptions).orElse(DEFAULTS.maxQuestionOptions()),
                    Optional.ofNullable(maxQuestionChars).orElse(DEFAULTS.maxQuestionChars()),
                    Optional.ofNullable(commandTimeoutSeconds)
                            .orElse(DEFAULTS.commandTimeoutSeconds()),
                    Optional.ofNullable(chatReserveWidth).orElse(DEFAULTS.chatReserveWidth()),
                    Optional.ofNullable(dockMaxWidth).orElse(DEFAULTS.dockMaxWidth()),
                    Optional.ofNullable(maxTokens).orElse(DEFAULTS.maxTokens()));
        }

        /**
         * The environment as a config layer: only the SPECTRO_* variables it actually
         * sets. Parsing mirrors the per-field code this factory replaces exactly —
         * {@code thinking}/{@code promptCaching} accept only "1"/"true" as true (see
         * {@link SpectroConfig#parseBool}), and a malformed {@code SPECTRO_MAX_RETRIES}
         * fails loudly instead of being swallowed (see
         * {@link SpectroConfig#parseMaxRetries}) — both pinned by the test suite.
         *
         * @param env the environment map (injectable for tests; production callers
         *            pass {@code System.getenv()})
         * @return a layer with just the SPECTRO_* fields the environment defines;
         *         every other field stays null
         */
        static PartialConfig fromEnv(Map<String, String> env) {
            PartialConfig out = new PartialConfig();
            out.provider = env.get("SPECTRO_PROVIDER");
            out.model = env.get("SPECTRO_MODEL");
            out.baseUrl = env.get("SPECTRO_BASE_URL");
            // Card 193: each local-model provider's OWN address, kept apart
            // from the shared legacy baseUrl above.
            out.ollamaBaseUrl = env.get("SPECTRO_OLLAMA_BASE_URL");
            out.lmstudioBaseUrl = env.get("SPECTRO_LMSTUDIO_BASE_URL");
            out.llamacppBaseUrl = env.get("SPECTRO_LLAMACPP_BASE_URL");
            // Card 203: the SearXNG instance web_search dials. This is the
            // PROCESS variable only; the file half that lets
            // samples/09-searxng/install.sh hand the address over through
            // ~/.spectro/.env lives in envLayer below, beside the OTLP pair.
            out.searxngUrl = env.get("SPECTRO_SEARXNG_URL");
            // Card 199: the net fence's local-verify-loop opt-in. Same 1/0/true/false
            // spelling as SPECTRO_THINKING; unset leaves loopback refused.
            String allowLocalhost = env.get("SPECTRO_ALLOW_LOCALHOST");
            if (allowLocalhost != null) {
                out.allowLocalhost = parseBool(allowLocalhost);
            }
            // Card 220: the headless faces' MCP opt-in. Same 1/0/true/false
            // spelling; unset keeps the unattended belt at the standard tools.
            String headlessMcp = env.get("SPECTRO_HEADLESS_MCP");
            if (headlessMcp != null) {
                out.headlessMcp = parseBool(headlessMcp);
            }
            // SPECTRO_WORKSPACE names the agent's working directory; unset keeps the
            // per-session temp folder (resolved later, when the session id exists).
            out.workspace = env.get("SPECTRO_WORKSPACE");
            out.imageProvider = env.get("SPECTRO_IMAGE_PROVIDER");
            // The OTLP exporter (off unless an endpoint is set): traces of every
            // run stream to the configured backend (Langfuse, Jaeger, ...).
            out.otlpEndpoint = env.get("SPECTRO_OTLP_ENDPOINT");
            out.otlpBasicAuth = env.get("SPECTRO_OTLP_BASIC_AUTH");
            // SPECTRO_THINKING (1/0/true/false) sits next to SPECTRO_PROVIDER in the env layer.
            String thinking = env.get("SPECTRO_THINKING");
            if (thinking != null) {
                out.thinking = parseBool(thinking);
            }
            String maxRetries = env.get("SPECTRO_MAX_RETRIES");
            if (maxRetries != null) {
                out.maxRetries = parseMaxRetries(maxRetries);
            }
            String promptCaching = env.get("SPECTRO_PROMPT_CACHING");
            if (promptCaching != null) {
                out.promptCaching = parseBool(promptCaching);
            }
            // SPECTRO_LOG_LEVEL steers the file-appender detail — the
            // same defaults < config file < env precedence as everything else.
            String logLevel = env.get("SPECTRO_LOG_LEVEL");
            if (logLevel != null) {
                out.logLevel = logLevel.trim().toLowerCase(java.util.Locale.ROOT);
            }
            // The three settings-productization fields: this is only their ENV
            // layer — every face now reads the resolved config field instead of
            // getenv (GenerateImageTool/imageModel, DoctorCommand.sttModelPath/
            // Transcriber/TranscribeController via sttModel, BrowsePageTool via
            // chromeEnv()'s SPECTRO_CHROME overlay), so a settings file can set
            // any of the three exactly like every other field.
            out.imageModel = env.get("SPECTRO_IMAGE_MODEL");
            out.sttModel = env.get("SPECTRO_STT_MODEL");
            out.sttProvider = env.get("SPECTRO_STT_PROVIDER");
            out.sttLanguage = env.get("SPECTRO_STT_LANGUAGE");
            out.chromeBinary = env.get("SPECTRO_CHROME");
            return out;
        }

        /**
         * The environment layer as the loader actually builds it: {@link #fromEnv}
         * with {@code ~/.spectro/.env} underneath it for the fields an INSTALLER
         * writes — the two OTLP fields (card 137) and the SearXNG address
         * (card 203).
         *
         * <p>Only those, and for one reason: they are what a sample installer
         * hands over to a user who is not going through a launcher. The desktop
         * shell spawns the jar with no {@code .env} loading at all, and a running
         * JVM cannot change its own {@code System.getenv}, so without this a file
         * the installer just wrote would be silently ignored until the next shell
         * export. This is the same two-step {@link SpectroConfig#resolveApiKey}
         * already performs for API keys, including treating a blank process var as
         * absent, and it changes no precedence BETWEEN layers: this is still the
         * env layer, still directly above the defaults, still outranked by every
         * settings file.
         *
         * <p>The SearXNG entry is here because it was missing and the gap was
         * invisible: {@code samples/09-searxng/install.sh} wrote
         * {@code SPECTRO_SEARXNG_URL} into this file, said so, and told the user to
         * restart — and the address then reached nothing, because an address is not
         * an API key and only {@link SpectroConfig#resolveApiKey} read that file by
         * name. The rule this leaves behind: a variable an installer writes into
         * {@code ~/.spectro/.env} needs a line HERE, or the installer is lying.
         * {@code WebSearchSettingsPlumbingTest} fails when this one is removed.</p>
         *
         * @param env the process environment (injectable for tests)
         * @return the env layer, with the installer-written fields filled from
         *         {@code ~/.spectro/.env} when the process environment leaves them unset
         */
        static PartialConfig envLayer(Map<String, String> env) {
            PartialConfig out = fromEnv(env);
            if (out.otlpEndpoint == null || out.otlpEndpoint.isBlank()) {
                String fromFile = dotEnvValue("SPECTRO_OTLP_ENDPOINT");
                if (fromFile != null) {
                    out.otlpEndpoint = fromFile;
                }
            }
            if (out.otlpBasicAuth == null || out.otlpBasicAuth.isBlank()) {
                String fromFile = dotEnvValue("SPECTRO_OTLP_BASIC_AUTH");
                if (fromFile != null) {
                    out.otlpBasicAuth = fromFile;
                }
            }
            if (out.searxngUrl == null || out.searxngUrl.isBlank()) {
                String fromFile = dotEnvValue("SPECTRO_SEARXNG_URL");
                if (fromFile != null) {
                    out.searxngUrl = fromFile;
                }
            }
            return out;
        }

        /**
         * CLI flags as the top config layer — sparse, only what the flags can
         * express. {@code compactionThreshold} and {@code permissionMode} have no
         * environment counterpart, so this is their only non-file source;
         * {@code imageProvider}/{@code thinking}/{@code maxRetries}/
         * {@code promptCaching}/{@code logLevel} have no flag at all and so never
         * appear here.
         *
         * @param overrides the CLI layer; null fields defer to the layers below
         * @return a layer with just the flag-settable fields; every other field
         *         stays null
         */
        static PartialConfig fromOverrides(Overrides overrides) {
            PartialConfig out = new PartialConfig();
            out.provider = overrides.provider();
            out.model = overrides.model();
            out.baseUrl = overrides.baseUrl();
            out.compactionThreshold = overrides.compactionThreshold();
            out.permissionMode = overrides.permissionMode();
            out.workspace = overrides.workspace();
            return out;
        }
    }
}
