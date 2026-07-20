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

        assertEquals(List.of("explore", "worker", "build_plan", "write_spec", "develop", "test"),
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
        assertEquals(List.of("spawn_agent", "spawn_agents", "build_plan", "write_spec", "develop", "test"),
                parent.stream().map(RoleCatalog.ToolSummary::name).toList());
        RoleCatalog.ToolSummary test = parent.stream()
                .filter(s -> s.name().equals("test")).findFirst().orElseThrow();
        assertTrue(test.description().contains("worker subagent"));
        assertTrue(test.description().contains("verification"));
    }
}
