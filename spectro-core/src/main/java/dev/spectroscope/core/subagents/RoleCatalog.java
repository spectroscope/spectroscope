package dev.spectroscope.core.subagents;

import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.Set;

/**
 * The subagent ROLE CATALOG, extracted from SubagentManager (clean-code night
 * job): every string a role is made of — the explore/worker/research system
 * prompts, the per-role tool sets, the spawn tool descriptions and the five
 * role-tool specs (four dev roles + the card-205 research role) — plus the
 * introspection views ({@link #roleProfiles} and {@link #parentTools}) the
 * System-Kontext panel renders. Single source of truth: the live tools in
 * SubagentManager and the introspection endpoints read the SAME constants, so
 * what the UI shows is what the LLM gets.
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

    /**
     * The base tools a RESEARCH child keeps (card 205): the explore read set
     * plus use_skill, because the role's whole point is carrying the
     * {@code spectroscope:research} skill in its belly. No write tool, no
     * run_command — a research child reads and reaches the web, nothing else.
     */
    static final Set<String> RESEARCH_BASE_TOOL_NAMES =
            Set.of("list_dir", "read_file", "glob", "grep", "use_skill");

    /**
     * The web grant of the research role, in the card's order. These names are
     * a PROMISE about which of the parent's tools a research child inherits —
     * the instances come from {@link SubagentConfig#webTools()}, so a face
     * without web tools (headless, fleet) grants nothing here. The grant does
     * not bypass the card-199 permission tiers: the child's calls run on the
     * SAME tool instances and the SAME broker as the parent's, so web_search
     * and web_fetch prompt as read-tier network egress and browse_page as
     * write-tier, exactly as they do for the main agent. The role widens what
     * a child can ASK for, never what the gate approves.
     */
    static final List<String> WEB_TOOL_NAMES = List.of("web_search", "web_fetch", "browse_page");

    /**
     * What a role does to the belt it is handed — the ONE place a role's reach is
     * decided (card 270, criterion 4).
     *
     * <p>Before this card the answer lived in two files and neither said it out
     * loud: {@code SessionConnection} hand-listed the child base as
     * {@code StandardTools.all()} plus {@code use_skill}, and
     * {@code SubagentManager.registryFor} switched on the type. A reader asking
     * "what can this child do" had to trace both, and the honest answer was
     * "less than the parent, by accident" — the browser family and every MCP
     * server the operator configured were missing from a child, which is exactly
     * what the baseline model in {@code konzept/ORCHESTRATION.md} §2 worked out
     * for itself before declining the {@code test} role.</p>
     *
     * <p>Now the belt comes from the shared supplier step and a role only ever
     * <b>narrows</b> it. Two shapes of narrowing, and the difference matters:</p>
     *
     * <ul>
     *   <li>a <b>keep list</b> ({@code keep} non-null) is an allow-list: a tool
     *       family added to the parent does NOT reach this role until someone
     *       names it here. That is the right default for a role whose promise is
     *       a small surface — {@code explore} says "no writing, no command
     *       execution" in its own system prompt, and a keep list is what makes
     *       that true by construction rather than by review;</li>
     *   <li>a <b>withhold list</b> ({@code keep} null) takes the whole belt minus
     *       the named families. That is what {@code worker} needs: the same hands
     *       as its parent, so a tool the parent gains cannot silently miss it.</li>
     * </ul>
     *
     * @param keep     the exact tool names this role holds, or null for "the whole
     *                 belt minus {@code withhold}"
     * @param withhold names this role gives up out of the whole belt — read only
     *                 when {@code keep} is null
     * @param grant    names the role adds from the session's explicit grant list
     *                 (the card-205 web trio), for a face whose belt does not
     *                 carry them
     */
    record BeltPolicy(Set<String> keep, Set<String> withhold, List<String> grant) {

        /** Whether a tool of this name reaches a child of this role.
         *  @param toolName the wire name as the belt carries it
         *  @return true when the role holds it */
        boolean holds(String toolName) {
            return keep != null ? keep.contains(toolName) : !withhold.contains(toolName);
        }
    }

    /**
     * What a {@code worker} gives up out of its parent's belt: nothing.
     *
     * <p>A worker IS the parent's hands, and that is the point of card 270. The
     * three parent-only families never enter a child's belt in the first place
     * and so are not withholdings but construction: the spawn verbs and the five
     * dev verbs are registered into the PARENT registry only (depth 1 by
     * construction, {@code SubagentManager.tools()} / {@code devTools()}), and
     * {@code update_plan} is main-only because a child writing the flat UI plan
     * snapshot would clobber it.</p>
     *
     * <p>Empty is a decision, not an oversight. The sentence a reader should be
     * able to find, with its exceptions rather than without them: <b>a worker
     * child holds this session's whole belt, under the same permission gate and
     * the same allowlist — everything except the verbs that are main-only by
     * construction.</b> Those are three, and none of them is a withholding:</p>
     *
     * <ul>
     *   <li>the spawn verbs and the five dev verbs, registered into the PARENT
     *       registry only, so depth stays 1;</li>
     *   <li>{@code update_plan}, because a child writing the flat UI plan
     *       snapshot would clobber the operator's view;</li>
     *   <li>{@code ask_user_question} (card 265), decided when this half was
     *       merged: a child's question would park the operator behind a spawn
     *       they never approved, and on the CLI face the asker is the REPL's own
     *       console. Pinned on both faces —
     *       {@code SessionChildBeltTest#aChildIsNotHandedTheVerbsThatBelongToTheMainAgentAlone}
     *       and its CLI sibling in {@code SpectroCliAskerTest}.</li>
     * </ul>
     */
    static final Set<String> WORKER_WITHHOLDS = Set.of();

    /**
     * The belt policy of one child profile — the answer to "what can this child
     * do", in one lookup.
     *
     * @param type the child profile
     * @return its policy over the shared belt
     */
    static BeltPolicy beltPolicy(AgentType type) {
        return switch (type) {
            case WORKER -> new BeltPolicy(null, WORKER_WITHHOLDS, List.of());
            case EXPLORE -> new BeltPolicy(EXPLORE_TOOL_NAMES, Set.of(), List.of());
            case RESEARCH -> new BeltPolicy(RESEARCH_BASE_TOOL_NAMES, Set.of(), WEB_TOOL_NAMES);
        };
    }

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
                    + "your requester sees.",
            AgentType.RESEARCH,
            "You are a web research subagent (type research). You can read the workspace "
                    + "(list_dir, read_file, glob, grep) and reach the web (web_search, web_fetch, "
                    + "browse_page) — no writing, no command execution. Web calls are "
                    + "permission-gated like everything else; a refused call is an answer, work "
                    + "with what you have. Carry out exactly the research task you were given. "
                    + "Answer as a compact memo WITH SOURCES: every claim names where it came "
                    + "from. Your final text is the only thing your requester sees.");

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

    /** One development tool = a role wrapper over a child spawn. Static so both
     *  devTools() (live) and roleProfiles()/parentTools() (introspection) share
     *  the exact same strings — no duplication.
     *
     *  @param name        the tool's wire name (build_plan, write_spec, develop, test, research)
     *  @param description base model-facing text — {@link #devToolDescription} appends the type/skill note
     *  @param preamble    role framing composed in front of the task the child runs on
     *  @param skill       the SKILL.md package the child is told to load first
     *  @param type        the child profile the role runs as — worker for the four
     *                     dev roles, research for the card-205 role (read tools +
     *                     the gated web grant, see {@link #WEB_TOOL_NAMES}) */
    record DevSpec(String name, String description, String preamble, String skill, AgentType type) {}

    static final List<DevSpec> DEV_SPECS = List.of(
            new DevSpec("build_plan",
                    "Delegates planning to a subagent: turns a feature request into a "
                            + "step-by-step implementation plan (a written plan document).",
                    "You are acting as a senior PLANNER. Produce a concrete step-by-step "
                            + "implementation plan for the task below and, if you have write access, "
                            + "save it as a markdown file. If a use_skill tool is available, load the "
                            + "skill 'writing-plans' first and follow it.",
                    "writing-plans", AgentType.WORKER),
            new DevSpec("write_spec",
                    "Delegates specification to a subagent: turns a rough idea into a "
                            + "design/spec document with decisions and trade-offs.",
                    "You are acting as a requirements ANALYST. Write a compact design spec "
                            + "for the task below: goal, approach, alternatives considered, decisions. "
                            + "If a use_skill tool is available, load the skill 'brainstorming' first "
                            + "and follow its structure.",
                    "brainstorming", AgentType.WORKER),
            new DevSpec("develop",
                    "Delegates implementation to a subagent: carries out a development task "
                            + "in small verified steps.",
                    "You are acting as an IMPLEMENTER. Carry out the development task below "
                            + "in small steps and verify each one. If a use_skill tool is available, "
                            + "load the skill 'test-driven-development' first and follow it.",
                    "test-driven-development", AgentType.WORKER),
            new DevSpec("test",
                    "Delegates verification to a subagent: runs and inspects, reports "
                            + "evidence, changes nothing.",
                    "You are acting as a TESTER. Verify the subject below: run what can be "
                            + "run, read what must be read, and report concrete evidence (commands, "
                            + "output, file paths). Do NOT fix anything. If a use_skill tool is "
                            + "available, load the skill 'verification' first and follow it.",
                    "verification", AgentType.WORKER),
            // Card 205: the research role. Read tools + the web grant, and card
            // 207's skill in its belly. Its web calls stay permission-gated —
            // the description says so, because a model told otherwise would
            // promise its requester an open web this product does not hand out.
            new DevSpec("research",
                    "Delegates web research to a subagent: searches, reads and verifies "
                            + "sources for a question the workspace cannot answer, and reports "
                            + "findings with sources. Its web tools are permission-gated like the "
                            + "parent's own.",
                    "You are acting as a RESEARCHER. Answer the research task below from the "
                            + "web, with sources: search in angles, read what you cite, verify "
                            + "load-bearing claims against a second source. You can read the "
                            + "workspace but not change it. If a use_skill tool is available, load "
                            + "the skill 'spectroscope:research' first and follow it.",
                    "spectroscope:research", AgentType.RESEARCH));

    /**
     * The full LLM-facing description of a dev tool (base + the type/skill note).
     *
     * @param spec the dev tool being described
     * @return the composed text handed to the provider and the introspection view alike
     */
    static String devToolDescription(DevSpec spec) {
        return spec.description() + " Runs as a " + spec.type().id() + " subagent (skill: "
                + spec.skill() + ") and reports "
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
     *  @param skill        the skill a dev role loads first, null for plain spawns
     *  @param withholds    what this role gives up out of the belt it was handed
     *                      (card 270, criterion 4) — empty for a worker, which
     *                      carries its parent's hands. Additive: an extra field
     *                      on an HTTP payload, never on the frozen RunEvent wire */
    public record RoleProfile(String type, String kind, String systemPrompt,
                              List<String> tools, boolean readOnly, String skill,
                              List<String> withholds) {}

    /** A parent-only tool's name + LLM-facing description (spawn + dev).
     *
     *  @param name        the tool's wire name
     *  @param description the exact text the provider advertises to the model */
    public record ToolSummary(String name, String description) {}

    /**
     * The subagent role profiles for the System-Kontext view. childBaseToolNames
     * is the belt the face hands to children — since card 270 that is the SAME
     * supplier step the parent's own belt comes from, so the browser family, the
     * launch family and — in a LIVE session — the operator's MCP tools are in it.
     * The one caller of this method, {@code ContextDescriber}, serves a
     * STATELESS endpoint: no session has been dialled, so it can hand over no
     * MCP names and says so itself. Explore is filtered
     * to its read-only keep list, worker carries the belt whole, and both get
     * report_status. Dev tools run as workers with a role preamble + a skill —
     * except research (card 205), which runs on the read set plus the gated web
     * grant of {@link #WEB_TOOL_NAMES}. The research profile lists the role's
     * PROMISE; a face that carries no web tools (headless, fleet) grants none,
     * so its research children hold none — the unattended lanes stay closed.
     *
     * <p>Every list here comes out of {@link #beltPolicy}, the same lookup the
     * live registry is built from — pinned by
     * {@code SubagentManagerTest#aChildsLiveRegistryIsTheListRoleCatalogAdvertisesForItsRole},
     * which reads the specs a child is really advertised rather than comparing
     * this method to itself.</p>
     *
     * <p>{@link RoleProfile#withholds()} answers "what did this role give up"
     * without a reader tracing a second file — <b>on the payload</b>. It is
     * computed here and shipped on {@code /api/context}, and
     * {@code SystemContextTab.tsx} does not read it: the consumer is
     * structurally typed and simply drops the field. So criterion 4's readable
     * half exists in Java and in the JSON, and not yet on a screen. Rendering it
     * is follow-up work, named here rather than promised.</p>
     *
     * @param childBaseToolNames names of the base tools a child may inherit
     * @return one profile per role: explore, worker, then the five role tools
     */
    public static List<RoleProfile> roleProfiles(List<String> childBaseToolNames) {
        List<String> exploreTools = toolsOf(AgentType.EXPLORE, childBaseToolNames);
        List<String> workerTools = toolsOf(AgentType.WORKER, childBaseToolNames);
        List<String> researchTools = toolsOf(AgentType.RESEARCH, childBaseToolNames);
        List<RoleProfile> out = new ArrayList<>();
        out.add(new RoleProfile("explore", "spawn", SYSTEM_PROMPTS.get(AgentType.EXPLORE),
                exploreTools, true, null, withheldBy(AgentType.EXPLORE, childBaseToolNames)));
        out.add(new RoleProfile("worker", "spawn", SYSTEM_PROMPTS.get(AgentType.WORKER),
                workerTools, false, null, withheldBy(AgentType.WORKER, childBaseToolNames)));
        for (DevSpec spec : DEV_SPECS) {
            // Research is not read-only: its file surface is, but network egress
            // is a side effect, so the badge would overpromise.
            out.add(new RoleProfile(spec.name(), "dev", spec.preamble(),
                    spec.type() == AgentType.RESEARCH ? researchTools : workerTools,
                    false, spec.skill(), withheldBy(spec.type(), childBaseToolNames)));
        }
        return out;
    }

    /**
     * The exact tool names a child of one role ends up holding — the SAME
     * policy {@code SubagentManager.registryFor} builds the live registry from,
     * so the introspection answer and the child's real belt cannot drift apart.
     *
     * @param type      the child profile
     * @param beltNames the belt the face hands to children, in registration order
     * @return the role's tool names, report_status last
     */
    static List<String> toolsOf(AgentType type, List<String> beltNames) {
        BeltPolicy policy = beltPolicy(type);
        List<String> out = new ArrayList<>(beltNames.stream().filter(policy::holds).toList());
        policy.grant().stream().filter(name -> !out.contains(name)).forEach(out::add);
        out.add("report_status");
        return List.copyOf(out);
    }

    /**
     * What this role gave up out of the belt it was handed — the readable half of
     * {@link BeltPolicy}, computed against the ACTUAL belt so the answer names
     * real tools rather than a policy in the abstract.
     *
     * @param type      the child profile
     * @param beltNames the belt the face hands to children
     * @return the withheld names in belt order; empty for a worker
     */
    static List<String> withheldBy(AgentType type, List<String> beltNames) {
        BeltPolicy policy = beltPolicy(type);
        return beltNames.stream().filter(name -> !policy.holds(name)).toList();
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
