package dev.spectroscope.core.launch;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ArrayNode;
import com.fasterxml.jackson.databind.node.ObjectNode;
import dev.spectroscope.core.browser.BrowserFace;
import dev.spectroscope.core.config.governing.Governs;
import dev.spectroscope.core.net.NetFence;
import dev.spectroscope.core.tools.Tool;
import dev.spectroscope.core.tools.ToolOutput;

import java.time.Duration;
import java.util.List;
import java.util.Optional;
import java.util.function.Supplier;

/**
 * The five launch tools of card 202 — "show me the change running" as one
 * thought instead of three.
 *
 * <p>The file they read is {@code .spectro/launch.json} when the project carries
 * one and Claude Code's own {@code .claude/launch.json} otherwise (card 350).
 * Reading theirs at all is card 202's compatibility goal rather than a
 * convenience: a repository already set up for Claude Code brings its
 * configurations along unedited, with no second config file to write. {@link LaunchFile} owns what the format is, where it is
 * looked for and how forgiving the reader has to be; this class owns everything
 * the model sees.
 *
 * <p>None of the five writes anything. Card 352 asks whether spectroscope may
 * author a launch file, and the answer for the AGENT is not yet given — see
 * {@link LaunchWriter}, which no tool here reaches.
 *
 * <h2>The tiers, and why each one is what it is</h2>
 *
 * <p>Card 199 rates a tool by what it can DO, and the shipped map is where the
 * rating lives. What these five got, and the reason:
 *
 * <ul>
 *   <li>{@code launch_start} and {@code launch_restart} are <b>eval-execute</b>,
 *       the same tier as {@code run_command}, because they do the same thing:
 *       they run a program of somebody else's choosing, with arguments of
 *       somebody else's choosing, as this user on this machine. The indirection
 *       through a file does not shrink that. A repository the agent has just
 *       cloned wrote that file, and {@code runtimeExecutable} is a free string —
 *       a {@code .claude/launch.json} is a remote-code-execution primitive
 *       wearing a config file's clothes, and rating it below {@code run_command}
 *       would let one wildcard approve by the back door what the front door
 *       prompts for.</li>
 *   <li>{@code launch_stop} is <b>write</b>. It runs no code and it can only
 *       reach a process THIS session started: an attached entry is refused
 *       rather than signalled, so the reach is bounded by what the same session
 *       already spawned under the eval-execute gate. Ending a process is acting
 *       on the machine, which is what write means here, exactly as
 *       {@code browser_navigate} acts on the pane.</li>
 *   <li>{@code launch_list} and {@code launch_logs} are <b>read</b>. One reads a
 *       file in the project, the other reads output already captured. Neither
 *       starts, stops or reaches anything.</li>
 * </ul>
 *
 * <h2>localhost, which is the whole point and the one thing the fence refuses</h2>
 *
 * <p>Card 199's net fence refuses loopback unless the operator opted in, and
 * every address this card produces is loopback. The two are not reconciled by
 * making an exception — the fence exists because a prompt-injected page must not
 * be able to send the agent at this machine, and a launch file is not a stronger
 * warrant than a page. So the fence keeps its verdict on the BROWSER, and the
 * split is:
 *
 * <ul>
 *   <li>the app still starts, because starting a process is not a network reach
 *       and the fence has no remit over it;</li>
 *   <li>the browser is not pointed at it, and the sentence says all four things
 *       a reader needs: that the server is up, that the browser was not opened,
 *       why, and the one setting that changes it.</li>
 * </ul>
 *
 * <p>Refusing to start would have been the tidier code and the worse product: it
 * would leave a reader with no server, no logs and a fence message about an
 * address nothing is listening on. With the split, {@code launch_logs} still
 * answers, which is where a broken build says what is wrong.
 */
public final class LaunchTools {

    private static final ObjectMapper JSON = new ObjectMapper();

    /** How long a start waits by default, in seconds, as the schema advertises it. */
    @Governs(kind = Governs.Kind.MODEL_CHOICE, unit = Governs.Unit.SECONDS)
    static final int DEFAULT_WAIT_SECONDS = (int) LaunchSupervisor.DEFAULT_BUDGET.toSeconds();

    /** The longest wait a caller may ask for. A dev server that takes longer is broken. */
    @Governs(kind = Governs.Kind.FIXED, unit = Governs.Unit.SECONDS)
    static final int MAX_WAIT_SECONDS = 180;

    /** How many log lines {@code launch_logs} returns unless asked otherwise. */
    @Governs(kind = Governs.Kind.MODEL_CHOICE, unit = Governs.Unit.LINES)
    static final int DEFAULT_LOG_LINES = 80;

    /** What every tool here says when the project carries no launch file. */
    static final String NO_FILE = "this project carries no launch file at "
            + LaunchFile.LOCATIONS_SENTENCE
            + ". Both are the same format: a top-level \"version\" beside a"
            + " \"configurations\" array, and per entry a \"name\", a \"port\", and either a"
            + " \"runtimeExecutable\" with \"runtimeArgs\" to start, or a \"url\" of a server"
            + " that is already running. It is written by hand.";

    private final LaunchSupervisor supervisor;
    private final Supplier<BrowserFace> face;
    private final Supplier<NetFence> fence;

    /**
     * Builds the family against this session's supervisor and browser.
     *
     * @param supervisor what this session has running — one per session, closed
     *                   when the session closes
     * @param face       this session's browser, read per call like the browser
     *                   family does: the desktop shell can attach and restart
     *                   between two tool calls
     * @param fence      the net fence, read per call so an {@code allowLocalhost}
     *                   opt-in saved mid-session reaches the next call
     */
    public LaunchTools(LaunchSupervisor supervisor, Supplier<BrowserFace> face,
                       Supplier<NetFence> fence) {
        this.supervisor = supervisor;
        this.face = face;
        this.fence = fence;
    }

    /**
     * The family.
     *
     * @return the five tools, in the order a reader meets them
     */
    public List<Tool> all() {
        return List.of(list(), start(), stop(), restart(), logs());
    }

    // ---- launch_list ---------------------------------------------------------

    /**
     * Builds {@code launch_list}: what this repository can start.
     *
     * @return the list tool
     */
    private Tool list() {
        return new LaunchTool("launch_list",
                "Lists the launch configurations this repository carries in "
                        + LaunchFile.LOCATIONS_SENTENCE + ". Ours is read first; theirs is "
                        + "the same file Claude Code reads, so a repo already set up for it "
                        + "needs no second config file. Shows each "
                        + "configuration's name, what it runs, the address it answers on and "
                        + "whether it is up right now. Start here before guessing a port.",
                schema(properties -> { }),
                false) {

            @Override
            String run(JsonNode input, Tool.ToolContext context) {
                Optional<LaunchFile> read = LaunchFile.readFrom(context.cwd());
                if (read.isEmpty()) {
                    return "ERROR: launch_list found no configurations — " + NO_FILE;
                }
                LaunchFile file = read.get();
                if (file.entries().isEmpty()) {
                    return file.location() + " carries no configurations"
                            + (file.skipped() > 0
                                    ? " this reader can address: " + file.skipped()
                                            + " entries carry no \"name\"." : ".");
                }
                StringBuilder said = new StringBuilder(file.entries().size()
                        + " launch configuration" + (file.entries().size() == 1 ? "" : "s")
                        + " in " + file.location()
                        + (file.version() == null ? "" : " (version " + clean(file.version()) + ")")
                        + ":\n");
                for (LaunchEntry entry : file.entries()) {
                    said.append("- ").append(clean(entry.name())).append(" — ");
                    said.append(entry.attaches()
                            ? "attaches to " + clean(entry.address())
                                    + " (no command: spectroscope starts nothing for it)"
                            : "runs `" + clean(entry.commandLine()) + "`, opens "
                                    + clean(entry.address()));
                    supervisor.running(entry.name()).ifPresentOrElse(
                            running -> said.append(running.attached()
                                    ? " — ATTACHED now"
                                    : " — UP now, pid " + running.pid()),
                            () -> supervisor.exited(entry.name()).ifPresent(gone ->
                                    said.append(" — EXITED with code ").append(gone.code())
                                            .append("; launch_logs still reads what it printed")));
                    if (!entry.unknownKeys().isEmpty()) {
                        said.append(" [ignored keys: ")
                                .append(clean(String.join(", ", entry.unknownKeys())))
                                .append("]");
                    }
                    said.append("\n");
                }
                if (file.skipped() > 0) {
                    said.append(file.skipped())
                            .append(" entry without a \"name\" was skipped: there is no way to "
                                    + "address it.\n");
                }
                return ToolOutput.clip(said.toString(), ToolOutput.MAX_OUTPUT_CHARS);
            }
        };
    }

    // ---- launch_start --------------------------------------------------------

    /**
     * Builds {@code launch_start}: brings the app under test up and looks at it.
     *
     * @return the start tool
     */
    private Tool start() {
        return new LaunchTool("launch_start",
                "Starts a launch configuration by name. Waits until the port actually answers "
                        + "before saying it is up, so a success here means the app is reachable, "
                        + "not that a command was issued. It also points this session's browser "
                        + "at the address — EXCEPT on loopback, which is where a launch "
                        + "configuration almost always points: the net fence refuses localhost "
                        + "until allowLocalhost is opted into, and without that opt-in the app "
                        + "starts and no page is opened. The answer says which of the two "
                        + "happened, every time. An entry carrying a url and no command is "
                        + "ATTACHED instead: nothing is started, and it counts as up once that "
                        + "address answers. Use launch_list first if you do not know the names.",
                schema(properties -> {
                    properties.set("name", string("The configuration name, exactly as the "
                            + "launch file spells it. launch_list prints the names."));
                    properties.set("wait_seconds", integer("How long to wait for the address to "
                            + "answer. Default " + DEFAULT_WAIT_SECONDS + ", at most "
                            + MAX_WAIT_SECONDS + "."));
                }, "name"),
                true) {

            @Override
            String run(JsonNode input, Tool.ToolContext context) {
                return startOne(input, context, "launch_start");
            }
        };
    }

    // ---- launch_restart ------------------------------------------------------

    /**
     * Builds {@code launch_restart}: stop, then start, on the same name.
     *
     * @return the restart tool
     */
    private Tool restart() {
        return new LaunchTool("launch_restart",
                "Stops a launch configuration and starts it again, by name — the verb for "
                        + "picking up a change the dev server does not hot-reload. An entry that "
                        + "was ATTACHED rather than started is refused, for the same reason "
                        + "launch_stop refuses it: spectroscope did not start that server and "
                        + "does not own it.",
                schema(properties -> {
                    properties.set("name", string("The configuration name."));
                    properties.set("wait_seconds",
                            integer("How long to wait for the address after the restart."));
                }, "name"),
                true) {

            @Override
            String run(JsonNode input, Tool.ToolContext context) {
                String name = text(input, "name");
                LaunchSupervisor.Stopped stopped = supervisor.stop(name);
                if (stopped.wasAttached()) {
                    return "ERROR: " + attachedRefusal("launch_restart", name);
                }
                String outcome = startOne(input, context, "launch_restart");
                return stopped.stopped()
                        ? "Stopped " + clean(name) + " first. " + outcome
                        : outcome;
            }
        };
    }

    /** The body both start and restart run, so the two cannot drift apart. */
    private String startOne(JsonNode input, Tool.ToolContext context, String tool) {
        String name = text(input, "name");
        if (name.isBlank()) {
            return "ERROR: " + tool + " needs the name of a configuration — launch_list shows "
                    + "the names this repository carries.";
        }
        Optional<LaunchFile> read;
        try {
            read = LaunchFile.readFrom(context.cwd());
        } catch (IllegalArgumentException unreadable) {
            // The message names the location itself now that there are two of
            // them, so prefixing one here would be a guess about which failed.
            return "ERROR: " + tool + " could not read the launch file — "
                    + clean(unreadable.getMessage());
        }
        if (read.isEmpty()) {
            return "ERROR: " + tool + " cannot start \"" + clean(name) + "\": " + NO_FILE;
        }
        LaunchFile file = read.get();
        Optional<LaunchEntry> found = file.find(name);
        if (found.isEmpty()) {
            return "ERROR: " + tool + " found no configuration called \"" + clean(name)
                    + "\" in " + file.location() + ". It carries "
                    + (file.names().isEmpty()
                            ? "none at all."
                            : String.join(", ", file.names().stream()
                                    .map(LaunchTools::clean).toList()) + ".");
        }
        LaunchEntry entry = found.get();
        Duration budget = budget(input);
        LaunchSupervisor.Outcome outcome = supervisor.start(entry, context.cwd(), budget);
        if (!outcome.ok()) {
            return failedStart(tool, entry, outcome);
        }
        return openedOn(tool, entry, outcome.running());
    }

    /** Criterion 5: the failure names the configuration and the address it tried. */
    private static String failedStart(String tool, LaunchEntry entry,
                                      LaunchSupervisor.Outcome outcome) {
        String what = entry.attaches()
                ? "could not attach to \"" + clean(entry.name()) + "\" on "
                        + clean(String.valueOf(entry.address()))
                : "could not start \"" + clean(entry.name()) + "\" on "
                        + clean(String.valueOf(entry.address()));
        String said = "ERROR: " + tool + " " + what + " — " + outcome.problem() + ".";
        if (entry.attaches()) {
            said += " That entry carries a url and no command, so spectroscope starts nothing "
                    + "for it: the server has to be up already.";
        } else {
            said += " It ran `" + clean(entry.commandLine()) + "`.";
        }
        if (!outcome.tail().isBlank()) {
            said += "\nWhat it printed:\n"
                    + ToolOutput.clip(lastLines(outcome.tail(), 30), 2_000);
        }
        return said;
    }

    /** The success sentence, including the case where the fence keeps the browser away. */
    private String openedOn(String tool, LaunchEntry entry, LaunchSupervisor.Running running) {
        String address = clean(running.address());
        String head = running.attached()
                ? "Attached to \"" + clean(entry.name()) + "\" on " + address
                        + " — it was already running, and spectroscope started nothing"
                : "\"" + clean(entry.name()) + "\" is up on " + address
                        + " (pid " + running.pid() + ")";
        NetFence.Refusal refusal = fence.get().refuse(running.address());
        if (refusal != null) {
            // The fence sentence is a whole sentence and ends in its own period,
            // so nothing is appended to it — a live drive on 2026-08-13 showed
            // the double stop this used to produce.
            return head + ". The browser was NOT pointed at it: spectroscope "
                    + refusal.sentence()
                    + " The server keeps running — launch_logs reads what it prints, "
                    + "launch_stop ends it — so the opt-in is the only thing between you and "
                    + "the page.";
        }
        BrowserFace browser = face.get();
        if (browser == null || !browser.attached()) {
            return head + ", and no browser was opened on it — " + BrowserFace.DETACHED + ".";
        }
        ObjectNode args = JSON.createObjectNode().put("url", running.address());
        BrowserFace.Reply reply = browser.send("navigate", args);
        if (!reply.ok()) {
            return head + ", and the browser could not open " + address
                    + " — " + clean(reply.error());
        }
        String landed = reply.pageUrl() == null ? address : clean(reply.pageUrl());
        return head + ", and the browser is showing " + landed
                + ". launch_logs " + clean(entry.name()) + " reads what it prints.";
    }

    // ---- launch_stop ---------------------------------------------------------

    /**
     * Builds {@code launch_stop}: ends what this session started.
     *
     * @return the stop tool
     */
    private Tool stop() {
        return new LaunchTool("launch_stop",
                "Stops a launch configuration this session started, by name, together with "
                        + "everything it spawned — an `npm run dev` shell and the dev server "
                        + "under it both go. Everything this session started is stopped anyway "
                        + "when the session closes; this is the verb for freeing a port sooner. "
                        + "An ATTACHED entry is refused: spectroscope did not start that server.",
                schema(properties -> properties.set("name",
                        string("The configuration name.")), "name"),
                true) {

            @Override
            String run(JsonNode input, Tool.ToolContext context) {
                String name = text(input, "name");
                if (name.isBlank()) {
                    return "ERROR: launch_stop needs the name of a configuration.";
                }
                LaunchSupervisor.Stopped stopped = supervisor.stop(name);
                if (stopped.wasAttached()) {
                    return "ERROR: " + attachedRefusal("launch_stop", name);
                }
                if (!stopped.known()) {
                    return "ERROR: launch_stop has nothing running called \"" + clean(name)
                            + "\" in this session" + upNow() + ".";
                }
                if (stopped.exitCode() != null) {
                    return "\"" + clean(name) + "\" had already exited with code "
                            + stopped.exitCode() + " on its own, so there was nothing left to "
                            + "stop. Its output is dropped now — read it with launch_logs BEFORE "
                            + "stopping a configuration that died.";
                }
                return "Stopped \"" + clean(name) + "\" and everything it spawned.";
            }
        };
    }

    /**
     * The refusal for a process spectroscope never spawned — card 202's open
     * owner call, held open rather than settled.
     *
     * <p>Three answers are defensible and they are not the same product: refuse,
     * drop the attachment only, or kill whatever holds the port. Nobody has asked
     * for the third, and this machine's own launch file points at long-running
     * jars, so it is not hypothetical. Refusing keeps all three reachable; any
     * other choice here would decide it by shipping.
     */
    private static String attachedRefusal(String tool, String name) {
        return tool + " will not touch \"" + clean(name) + "\": that entry carries a url and no "
                + "command, so it was ATTACHED to a server that was already running — "
                + "spectroscope never started it and does not own it. What stop and restart "
                + "should mean for an attached entry is an open decision for the operator, and "
                + "until it is made nothing here signals a process it did not spawn. Stop that "
                + "server where you started it.";
    }

    // ---- launch_logs ---------------------------------------------------------

    /**
     * Builds {@code launch_logs}: what the app under test printed.
     *
     * @return the logs tool
     */
    private Tool logs() {
        return new LaunchTool("launch_logs",
                "Returns what a launch configuration this session started has printed, stdout "
                        + "and stderr merged, newest last — where a build error says what is "
                        + "wrong. An ATTACHED entry has no output here: spectroscope started no "
                        + "process for it and captured nothing, and the answer says so rather "
                        + "than showing an empty log as a healthy one.",
                schema(properties -> {
                    properties.set("name", string("The configuration name."));
                    properties.set("lines", integer("How many lines from the end. Default "
                            + DEFAULT_LOG_LINES + "; 0 for everything kept ("
                            + LaunchSupervisor.LOG_LINES + " lines at most)."));
                }, "name"),
                false) {

            @Override
            String run(JsonNode input, Tool.ToolContext context) {
                String name = text(input, "name");
                if (name.isBlank()) {
                    return "ERROR: launch_logs needs the name of a configuration.";
                }
                int lines = input.has("lines")
                        ? input.path("lines").asInt(DEFAULT_LOG_LINES) : DEFAULT_LOG_LINES;
                LaunchSupervisor.LogView view = supervisor.logs(name, lines);
                if (!view.known()) {
                    return "ERROR: launch_logs has nothing running called \"" + clean(name)
                            + "\" in this session" + upNow()
                            + ". Logs are kept only while a configuration is up.";
                }
                if (view.attached()) {
                    return "ERROR: launch_logs has no output for \"" + clean(name)
                            + "\": that entry carries a url and no command, so spectroscope "
                            + "started no process and captured nothing. Its output is wherever "
                            + "that server was started. This is not an empty log — it is no log.";
                }
                if (view.exitCode() != null) {
                    // The configuration is gone and its output outlived it. Say
                    // the death first: a log that ends mid-build reads like a
                    // running server until the reader is told otherwise.
                    return "\"" + clean(name) + "\" is NOT running — it exited with code "
                            + view.exitCode() + ". "
                            + (view.text().isBlank()
                                    ? "It printed nothing before it did."
                                    : "This is what it printed before it did:\n"
                                            + ToolOutput.clip(view.text(),
                                                    ToolOutput.MAX_OUTPUT_CHARS));
                }
                return view.text().isBlank()
                        ? "\"" + clean(name) + "\" has printed nothing yet."
                        : ToolOutput.clip(view.text(), ToolOutput.MAX_OUTPUT_CHARS);
            }
        };
    }

    /** ", and X is up" for a not-found sentence, so a typo is easy to see. */
    private String upNow() {
        List<LaunchSupervisor.Running> running = supervisor.running();
        if (running.isEmpty()) {
            return ", and nothing is up in it";
        }
        return ", and what is up is "
                + String.join(", ", running.stream()
                        .map(LaunchSupervisor.Running::name).map(LaunchTools::clean).toList());
    }

    /** The wait budget a call asked for, bounded. */
    private static Duration budget(JsonNode input) {
        int asked = input.path("wait_seconds").asInt(DEFAULT_WAIT_SECONDS);
        if (asked <= 0) {
            asked = DEFAULT_WAIT_SECONDS;
        }
        return Duration.ofSeconds(Math.min(asked, MAX_WAIT_SECONDS));
    }

    /** The last n lines of captured output. */
    private static String lastLines(String text, int n) {
        String[] split = text.split("\n", -1);
        int from = Math.max(0, split.length - n);
        return String.join("\n", List.of(split).subList(from, split.length));
    }

    // ---- the shared shape ----------------------------------------------------

    /** What every launch tool does the same way: never throw, always name itself. */
    private abstract static class LaunchTool implements Tool {

        private final String name;
        private final String description;
        private final JsonNode schema;
        private final boolean gated;

        LaunchTool(String name, String description, JsonNode schema, boolean gated) {
            this.name = name;
            this.description = description;
            this.schema = schema;
            this.gated = gated;
        }

        /** @return the wire name the model addresses this tool by */
        @Override
        public final String name() {
            return name;
        }

        /** @return the model-facing manual */
        @Override
        public final String description() {
            return description;
        }

        /** @return the JSON Schema advertised to the provider */
        @Override
        public final JsonNode inputSchema() {
            return schema;
        }

        /** @return whether this tool passes the permission gate first */
        @Override
        public final boolean needsPermission() {
            return gated;
        }

        /**
         * One call. Any escaped runtime failure becomes an "ERROR: " sentence
         * rather than a stack trace in the transcript.
         *
         * @param input   the model's arguments
         * @param context the run's per-call environment
         * @return the tool result
         */
        @Override
        public final String execute(JsonNode input, ToolContext context) {
            try {
                return run(input, context);
            } catch (RuntimeException failure) {
                return "ERROR: " + name + " failed — " + failure.getMessage();
            }
        }

        /**
         * The tool's own work.
         *
         * @param input   the model's arguments
         * @param context the run's per-call environment
         * @return the tool result
         */
        abstract String run(JsonNode input, ToolContext context);
    }

    /**
     * Untrusted text inside our own sentence: one line, bounded, no controls.
     *
     * <p><b>Every</b> string that came out of the launch file goes through here —
     * names, addresses, the version, ignored key names, command lines — and so
     * does every string that came back from the browser. That total is the
     * correction a review drove in on 2026-08-13: this rule existed and was
     * applied on every error path, and {@code launch_list} was echoing names and
     * addresses raw. A crafted {@code .claude/launch.json} whose entry name
     * carried newlines therefore printed a forged {@code === SYSTEM ===} block
     * and three invented configurations into the transcript, indistinguishable
     * from the real ones. That grants no execution by itself — {@code
     * launch_start} still meets the eval-execute gate — but {@code launch_list}
     * is tier read, never prompts, and its own description sends the agent here
     * first, so a repository the agent has merely cloned got attacker-chosen
     * structure into the transcript for free. One entry is now one line, always:
     * flattening the controls is what takes the forgery away, because a payload
     * that cannot start a new line cannot pretend to be a new entry.
     *
     * @param raw the text as the file or the browser wrote it
     * @return the same text, flattened to one line and bounded
     */
    private static String clean(String raw) {
        String flat = String.valueOf(raw).replaceAll("[\\p{Cntrl}]", " ").strip();
        return flat.length() <= 300 ? flat : flat.substring(0, 300) + "…";
    }

    /** Reads a string field, never null. */
    private static String text(JsonNode input, String field) {
        JsonNode node = input.path(field);
        return node.isTextual() ? node.asText() : "";
    }

    /** A schema with a properties block and an optional required list. */
    private static JsonNode schema(java.util.function.Consumer<ObjectNode> fill,
                                   String... required) {
        ObjectNode root = JSON.createObjectNode().put("type", "object");
        ObjectNode properties = JSON.createObjectNode();
        fill.accept(properties);
        root.set("properties", properties);
        if (required.length > 0) {
            ArrayNode names = JSON.createArrayNode();
            for (String name : required) {
                names.add(name);
            }
            root.set("required", names);
        }
        return root;
    }

    /** A string property with a description. */
    private static ObjectNode string(String description) {
        return JSON.createObjectNode().put("type", "string").put("description", description);
    }

    /** An integer property with a description. */
    private static ObjectNode integer(String description) {
        return JSON.createObjectNode().put("type", "integer").put("description", description);
    }
}
