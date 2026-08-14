package dev.spectroscope.core.subagents;

import org.junit.jupiter.api.Test;

import java.util.List;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

/** The introspection surface the System-Kontext view renders — moved next to
 *  its subject when the role catalog left SubagentManager. */
class RoleCatalogTest {

    @Test
    void roleProfilesExposeExploreWorkerAndDevTools() {
        List<String> base = List.of("list_dir", "read_file", "glob", "grep", "write_file", "run_command", "use_skill");
        List<RoleCatalog.RoleProfile> profiles = RoleCatalog.roleProfiles(base);

        assertEquals(List.of("explore", "worker", "build_plan", "write_spec", "develop", "test", "research"),
                profiles.stream().map(RoleCatalog.RoleProfile::type).toList());

        RoleCatalog.RoleProfile explore = profiles.get(0);
        assertTrue(explore.readOnly());
        assertEquals(List.of("list_dir", "read_file", "glob", "grep", "report_status"), explore.tools());
        assertTrue(RoleCatalog.parentTools().get(0).description().contains("glob"),
                "spawn_agent description enumerates the explore read tools");

        RoleCatalog.RoleProfile worker = profiles.get(1);
        assertTrue(!worker.readOnly());
        assertEquals(List.of("list_dir", "read_file", "glob", "grep", "write_file", "run_command", "use_skill", "report_status"),
                worker.tools());

        RoleCatalog.RoleProfile buildPlan = profiles.stream()
                .filter(p -> p.type().equals("build_plan")).findFirst().orElseThrow();
        assertEquals("dev", buildPlan.kind());
        assertEquals("writing-plans", buildPlan.skill());
        assertTrue(buildPlan.systemPrompt().contains("PLANNER"));
        assertEquals(worker.tools(), buildPlan.tools()); // dev tools run as workers
    }

    @Test
    void parentToolsListSpawnAndDevWithDescriptions() {
        List<RoleCatalog.ToolSummary> parent = RoleCatalog.parentTools();
        assertEquals(List.of("spawn_agent", "spawn_agents", "build_plan", "write_spec", "develop", "test",
                        "research"),
                parent.stream().map(RoleCatalog.ToolSummary::name).toList());
        RoleCatalog.ToolSummary test = parent.stream()
                .filter(s -> s.name().equals("test")).findFirst().orElseThrow();
        assertTrue(test.description().contains("worker subagent"));
        assertTrue(test.description().contains("verification"));
    }

    // ---- card 205: the research role — web reach as a granted role ---------------------

    @Test
    void researchProfileGrantsTheWebBesideTheReadToolsAndCarriesTheSkill() {
        List<String> base = List.of("list_dir", "read_file", "glob", "grep", "write_file", "run_command", "use_skill");
        RoleCatalog.RoleProfile research = RoleCatalog.roleProfiles(base).stream()
                .filter(p -> p.type().equals("research")).findFirst().orElseThrow();

        // The grant table of card 205, first row: the read set plus the three
        // web tools — never write_file, never run_command.
        assertEquals(List.of("list_dir", "read_file", "glob", "grep", "use_skill",
                        "web_search", "web_fetch", "browse_page", "report_status"),
                research.tools());
        assertEquals("dev", research.kind());
        assertEquals("spectroscope:research", research.skill(),
                "the role carries card 207's skill in its belly");
        assertTrue(research.systemPrompt().contains("RESEARCHER"));
        assertTrue(!research.readOnly(),
                "network egress is a side effect — this role must not wear the read-only badge");
    }

    @Test
    void researchToolDescriptionNamesTheGateAndTheSkill() {
        RoleCatalog.ToolSummary research = RoleCatalog.parentTools().stream()
                .filter(s -> s.name().equals("research")).findFirst().orElseThrow();
        assertTrue(research.description().contains("research subagent"),
                "the shared note must name the child type honestly, not claim a worker");
        assertTrue(research.description().contains("spectroscope:research"));
        assertTrue(research.description().contains("permission"),
                "web reach stays gated — the description says so instead of implying open web");
    }
}
