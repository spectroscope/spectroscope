package dev.spectroscope.core.subagents;

import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.Set;

/**
 * The subagent ROLE CATALOG, extracted from SubagentManager (clean-code night
 * job): every string a role is made of — the explore/worker system prompts,
 * the read-only tool set, the spawn tool descriptions and the four dev-tool
 * specs — plus the introspection views ({@link #roleProfiles} and
 * {@link #parentTools}) the System-Kontext panel renders. Single source of
 * truth: the live tools in SubagentManager and the introspection endpoints
 * read the SAME constants, so what the UI shows is what the LLM gets.
 */
public final class RoleCatalog {

    /** Static catalog — no instances. */
    private RoleCatalog() {
    }

    /**
     * explore may only read, BY CONSTRUCTION: every other tool is simply not
     * in its registry — more robust than any after-the-fact check.
     */
    static final Set<String> EXPLORE_TOOL_NAMES = Set.of("list_dir", "read_file", "glob", "grep");

    static final Map<AgentType, String> SYSTEM_PROMPTS = Map.of(
            AgentType.EXPLORE,
            "You are a research subagent (type explore). You can list directories (list_dir), "
                    + "read files (read_file), find files by glob pattern (glob) and search file "
                    + "contents (grep) — no writing, no command execution. Carry out exactly "
                    + "the task you were given. Answer as a compact memo: bullet points, concrete paths, "
                    + "findings. Your final text is the only thing your requester sees.",
            AgentType.WORKER,
            "You are a work subagent (type worker) with full tool access. Carry out exactly the "
                    + "task you were given, nothing more. At the end, summarize briefly what you did: "
                    + "changed files, executed commands, results. Your final text is the only thing "
                    + "your requester sees.");

    /** Descriptions of the parent-only spawn tools — also surfaced by the
     *  System-Kontext view, so they live as constants (single source of truth). */
    static final String SPAWN_AGENT_DESC =
            "Starts a subagent with a fresh context and waits for its result. type=explore: "
                    + "read-only (list_dir, read_file, glob, grep), for research. type=worker: all tools, for real "
                    + "subtasks. The subagent sees ONLY the task text — phrase it as a self-contained "
                    + "assignment.";
    static final String SPAWN_AGENTS_DESC =
            "Starts up to " + SubagentManager.MAX_PARALLEL_CHILDREN + " subagents IN PARALLEL and waits until "
                    + "all of them are finished. For independent subtasks (e.g. investigating several "
                    + "directories at the same time).";

    /** One development tool = a role wrapper over a worker spawn. Static so both
     *  devTools() (live) and roleProfiles()/parentTools() (introspection) share
     *  the exact same strings — no duplication.
     *
     *  @param name        the tool's wire name (build_plan, write_spec, develop, test)
     *  @param description base model-facing text — {@link #devToolDescription} appends the worker/skill note
     *  @param preamble    role framing composed in front of the task the worker child runs on
     *  @param skill       the SKILL.md package the child is told to load first */
    record DevSpec(String name, String description, String preamble, String skill) {}

    static final List<DevSpec> DEV_SPECS = List.of(
            new DevSpec("build_plan",
                    "Delegates planning to a subagent: turns a feature request into a "
                            + "step-by-step implementation plan (a written plan document).",
                    "You are acting as a senior PLANNER. Produce a concrete step-by-step "
                            + "implementation plan for the task below and, if you have write access, "
                            + "save it as a markdown file. If a use_skill tool is available, load the "
                            + "skill 'writing-plans' first and follow it.",
                    "writing-plans"),
            new DevSpec("write_spec",
                    "Delegates specification to a subagent: turns a rough idea into a "
                            + "design/spec document with decisions and trade-offs.",
                    "You are acting as a requirements ANALYST. Write a compact design spec "
                            + "for the task below: goal, approach, alternatives considered, decisions. "
                            + "If a use_skill tool is available, load the skill 'brainstorming' first "
                            + "and follow its structure.",
                    "brainstorming"),
            new DevSpec("develop",
                    "Delegates implementation to a subagent: carries out a development task "
                            + "in small verified steps.",
                    "You are acting as an IMPLEMENTER. Carry out the development task below "
                            + "in small steps and verify each one. If a use_skill tool is available, "
                            + "load the skill 'test-driven-development' first and follow it.",
                    "test-driven-development"),
            new DevSpec("test",
                    "Delegates verification to a subagent: runs and inspects, reports "
                            + "evidence, changes nothing.",
                    "You are acting as a TESTER. Verify the subject below: run what can be "
                            + "run, read what must be read, and report concrete evidence (commands, "
                            + "output, file paths). Do NOT fix anything. If a use_skill tool is "
                            + "available, load the skill 'verification' first and follow it.",
                    "verification"));

    /**
     * The full LLM-facing description of a dev tool (base + the worker/skill note).
     *
     * @param spec the dev tool being described
     * @return the composed text handed to the provider and the introspection view alike
     */
    static String devToolDescription(DevSpec spec) {
        return spec.description() + " Runs as a worker subagent (skill: " + spec.skill() + ") and reports "
                + "progress via report_status. The subagent sees ONLY the task text — phrase "
                + "it as a self-contained assignment.";
    }

    /** A subagent role as the System-Kontext view shows it: the exact system
     *  prompt (or dev preamble) and tool profile each type runs with.
     *
     *  @param type         role id — explore, worker, or a dev tool name
     *  @param kind         "spawn" for the two base types, "dev" for the role wrappers
     *  @param systemPrompt what the child actually runs with — the real system prompt, or the dev preamble
     *  @param tools        the exact tool names in the child's registry
     *  @param readOnly     true only for explore, enforced by registry construction
     *  @param skill        the skill a dev role loads first, null for plain spawns */
    public record RoleProfile(String type, String kind, String systemPrompt,
                              List<String> tools, boolean readOnly, String skill) {}

    /** A parent-only tool's name + LLM-facing description (spawn + dev).
     *
     *  @param name        the tool's wire name
     *  @param description the exact text the provider advertises to the model */
    public record ToolSummary(String name, String description) {}

    /**
     * The subagent role profiles for the System-Kontext view. childBaseToolNames
     * are the base tools a child inherits (StandardTools + use_skill); explore is
     * filtered to the read-only set, worker gets them all, and both get
     * report_status. Dev tools run as workers with a role preamble + a skill.
     *
     * @param childBaseToolNames names of the base tools a child may inherit
     * @return one profile per role: explore, worker, then the four dev roles
     */
    public static List<RoleProfile> roleProfiles(List<String> childBaseToolNames) {
        List<String> exploreTools = new ArrayList<>(childBaseToolNames.stream()
                .filter(EXPLORE_TOOL_NAMES::contains).toList());
        exploreTools.add("report_status");
        List<String> workerTools = new ArrayList<>(childBaseToolNames);
        workerTools.add("report_status");
        List<RoleProfile> out = new ArrayList<>();
        out.add(new RoleProfile("explore", "spawn", SYSTEM_PROMPTS.get(AgentType.EXPLORE),
                List.copyOf(exploreTools), true, null));
        out.add(new RoleProfile("worker", "spawn", SYSTEM_PROMPTS.get(AgentType.WORKER),
                List.copyOf(workerTools), false, null));
        for (DevSpec spec : DEV_SPECS) {
            out.add(new RoleProfile(spec.name(), "dev", spec.preamble(),
                    List.copyOf(workerTools), false, spec.skill()));
        }
        return out;
    }

    /**
     * The parent-only tools (spawn + dev) as name+description, for introspection.
     *
     * @return spawn_agent, spawn_agents, then one entry per dev tool — catalog order
     */
    public static List<ToolSummary> parentTools() {
        List<ToolSummary> out = new ArrayList<>();
        out.add(new ToolSummary("spawn_agent", SPAWN_AGENT_DESC));
        out.add(new ToolSummary("spawn_agents", SPAWN_AGENTS_DESC));
        for (DevSpec spec : DEV_SPECS) {
            out.add(new ToolSummary(spec.name(), devToolDescription(spec)));
        }
        return out;
    }
}
