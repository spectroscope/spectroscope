package dev.spectroscope;

import dev.spectroscope.core.AgentOptions;
import dev.spectroscope.core.CancelSignal;
import dev.spectroscope.core.EventStream;
import dev.spectroscope.core.RunOptions;
import dev.spectroscope.core.events.RunEvent;
import dev.spectroscope.core.provider.LlmProvider;
import dev.spectroscope.core.tools.Tool;
import dev.spectroscope.core.tools.ToolRegistry;

import java.nio.file.Path;
import java.util.List;
import java.util.Objects;

/**
 * The five-lines facade — spectroscope's front door. The surface is FROZEN
 * (product home: konzept/SPECTRO-API.md); new setters may join, these stay.
 *
 * <pre>{@code
 * var agent = Spectro.agent()
 *     .model(Anthropic.opus())
 *     .tools(Tools.readFile(), Tools.runCommand())
 *     .workspace(Path.of("/tmp/scratch"));
 *
 * for (RunEvent event : agent.run("Write hello.py and run it")) {
 *     System.out.println(event);   // the stream IS the observability
 * }
 * }</pre>
 *
 * <p>{@link Agent#run} returns the {@link EventStream} of the harness loop:
 * a plain {@link Iterable} of {@link RunEvent}, consumed with a blocking
 * for-loop — the loop itself runs on a virtual thread inside the core. No
 * reactive DSL, no callbacks, no subscription object in the happy path.</p>
 */
public final class Spectro {

    private Spectro() {}

    /**
     * The single entry point: a fresh agent under fluent construction.
     *
     * @return an agent whose setters chain; the first {@link Agent#run} freezes
     *         the configuration and opens the conversation
     */
    public static Agent agent() {
        return new Agent();
    }

    /**
     * The fleet path — several agents, one merged spectrum — in exactly the
     * facade's shape. The implementation lives in {@code spectro-orchestrator}
     * (a pure consumer of this core) and is resolved through the
     * {@link FleetPanelFactory} ServiceLoader hook.
     *
     * @return a fresh panel under fluent construction
     * @throws IllegalStateException when no fleet module is on the classpath
     */
    public static FleetPanel panel() {
        return java.util.ServiceLoader.load(FleetPanelFactory.class)
                .findFirst()
                .orElseThrow(() -> new IllegalStateException(
                        "no fleet module on the classpath — add dev.spectroscope:spectro-orchestrator"))
                .create();
    }

    /** One configured agent: setters chain, {@link #run} streams. */
    public static final class Agent {

        /** The embedded-library stance: nobody is at a terminal to answer. */
        private static final String UNATTENDED_PROMPT =
                "You are spectroscope, an embedded coding agent. There is no human at "
                + "the terminal: do not ask questions, carry out the assignment with "
                + "the available tools, and summarize the result briefly at the end. "
                + "If a tool is denied, do not retry it — state the denial in your result.";

        private LlmProvider provider;
        private List<Tool> tools = Tools.all();
        private Path workspace = Path.of(".");
        private String systemPrompt;
        private dev.spectroscope.core.Agent loop;

        private Agent() {}

        /**
         * The LLM backend the loop streams from — e.g. {@link Anthropic#opus()}.
         *
         * @param provider the provider; required before the first run
         * @return this agent, for chaining
         */
        public Agent model(LlmProvider provider) {
            mutable();
            this.provider = Objects.requireNonNull(provider, "provider");
            return this;
        }

        /**
         * The tool belt the model may call. Without this setter the agent
         * carries the full standard belt ({@link Tools#all()}).
         *
         * @param tools the tools, e.g. {@code Tools.readFile(), Tools.runCommand()}
         * @return this agent, for chaining
         */
        public Agent tools(Tool... tools) {
            mutable();
            this.tools = List.of(tools);
            return this;
        }

        /**
         * The directory the file tools resolve and sandbox against.
         *
         * @param workspace the agent's working directory
         * @return this agent, for chaining
         */
        public Agent workspace(Path workspace) {
            mutable();
            this.workspace = Objects.requireNonNull(workspace, "workspace");
            return this;
        }

        /**
         * Replaces the default unattended system prompt entirely.
         *
         * @param systemPrompt the full system prompt to send with every request
         * @return this agent, for chaining
         */
        public Agent systemPrompt(String systemPrompt) {
            mutable();
            this.systemPrompt = Objects.requireNonNull(systemPrompt, "systemPrompt");
            return this;
        }

        /**
         * Runs one prompt against the agent and hands back the live stream.
         * The first call freezes the configuration; later calls continue the
         * same conversation (history rides along).
         *
         * @param prompt the user prompt for this run
         * @return the typed event stream; iterate it with a for-loop — it ends
         *         by itself after {@code run_end}
         */
        public EventStream run(String prompt) {
            if (loop == null) {
                loop = build();
            }
            return loop.run(prompt, new RunOptions(new CancelSignal(), null));
        }

        private dev.spectroscope.core.Agent build() {
            if (provider == null) {
                throw new IllegalStateException(
                        "no model configured — call .model(Anthropic.opus()) before run()");
            }
            try {
                java.nio.file.Files.createDirectories(workspace);
            } catch (java.io.IOException e) {
                throw new IllegalStateException("workspace not creatable: " + workspace, e);
            }
            ToolRegistry registry = new ToolRegistry();
            tools.forEach(registry::register);
            String prompt = systemPrompt != null
                    ? systemPrompt
                    : UNATTENDED_PROMPT + "\nThe workspace is " + workspace + ".";
            return new dev.spectroscope.core.Agent(AgentOptions.builder()
                    .provider(provider)
                    .systemPrompt(prompt)
                    .registry(registry)
                    .cwd(workspace)
                    // Embedded default: allow — there is no human to ask; every
                    // request and decision still lands in the event stream.
                    .onPermission(request -> true)
                    .providerName(providerLabel())
                    .build());
        }

        /** run_start's provider field must carry a name, not null. */
        private String providerLabel() {
            String live = provider.providerName();
            if (live != null && !live.isBlank()) {
                return live;
            }
            String simple = provider.getClass().getSimpleName();
            if (simple.isBlank() || simple.contains("$") || simple.contains("Lambda")) {
                return "custom";
            }
            return simple.replaceAll("Provider$", "").toLowerCase();
        }

        private void mutable() {
            if (loop != null) {
                throw new IllegalStateException(
                        "the agent is already running — configure before the first run()");
            }
        }
    }
}
