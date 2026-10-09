package dev.spectroscope.core;

import com.fasterxml.jackson.databind.ObjectMapper;
import dev.spectroscope.core.provider.LlmProvider.ToolSpec;
import dev.spectroscope.core.subagents.RoleCatalog;
import dev.spectroscope.core.tools.StandardTools;
import dev.spectroscope.core.tools.Tool;
import org.junit.jupiter.api.Test;

import java.util.List;
import java.util.Optional;
import java.util.Set;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * Card 466, criterion 1 and the drift half of criterion 6: the seven groups,
 * named after what they switch off, and a membership that is read from the
 * tool's own name rather than from a hand list.
 */
class ToolGroupTest {

    private static final ObjectMapper JSON = new ObjectMapper();

    private static ToolSpec spec(String name) {
        return new ToolSpec(name, "d", JSON.createObjectNode());
    }

    private static List<String> names(List<ToolSpec> specs) {
        return specs.stream().map(ToolSpec::name).toList();
    }

    @Test
    void theSevenGroupsCarryTheNamesTheCardGivesThem() {
        assertEquals(List.of("browser", "launch", "images", "web", "agents", "roles", "mcp"),
                ToolGroup.wireNames());
        for (String name : ToolGroup.wireNames()) {
            assertEquals(name, ToolGroup.named(name).orElseThrow().wireName(), name);
        }
        assertEquals(Optional.empty(), ToolGroup.named("browsers"));
        assertEquals(Optional.empty(), ToolGroup.named("Browser"), "wire names are exact");
    }

    @Test
    void aNewBrowserToolJoinsItsGroupWithoutAHandList() {
        // Neither of the first two names exists today. A browser_* or
        // launch_* tool added tomorrow must go off with its family.
        assertEquals(Optional.of(ToolGroup.BROWSER), ToolGroup.of("browser_zoom_in"));
        assertEquals(Optional.of(ToolGroup.LAUNCH), ToolGroup.of("launch_restart"));
        assertEquals(Optional.of(ToolGroup.MCP), ToolGroup.of("mcp__notes__search"));
        assertEquals(Optional.of(ToolGroup.MCP), ToolGroup.of("mcp__gallery__generate_image"),
                "an MCP tool goes off with MCP, whatever its own name looks like");
        assertEquals(Optional.of(ToolGroup.BROWSER), ToolGroup.of("browser_navigate"));
        assertEquals(Optional.of(ToolGroup.LAUNCH), ToolGroup.of("launch_start"));
    }

    @Test
    void theNamedFamiliesLandInTheirGroups() {
        assertEquals(Optional.of(ToolGroup.IMAGES), ToolGroup.of("generate_image"));
        assertEquals(Optional.of(ToolGroup.IMAGES), ToolGroup.of("view_image"));
        assertEquals(Optional.of(ToolGroup.WEB), ToolGroup.of("web_fetch"));
        assertEquals(Optional.of(ToolGroup.WEB), ToolGroup.of("web_search"));
        assertEquals(Optional.of(ToolGroup.WEB), ToolGroup.of("browse_page"));
        assertEquals(Optional.of(ToolGroup.AGENTS), ToolGroup.of("spawn_agent"));
        assertEquals(Optional.of(ToolGroup.AGENTS), ToolGroup.of("spawn_agents"));
    }

    @Test
    void theRolesGroupIsReadFromTheRoleCatalog() {
        List<String> roles = RoleCatalog.devToolNames();
        assertEquals(5, roles.size(), "test premise: the catalog has the five dev roles");
        for (String role : roles) {
            assertEquals(Optional.of(ToolGroup.ROLES), ToolGroup.of(role), role);
        }
    }

    @Test
    void theToolsWithoutAGroupCanNeverBeSwitchedOff() {
        // The standard file tools, run_command, update_plan, ask_user_question
        // and the skill tools. view_image is a standard tool and sits in
        // images by the card's table; every other standard tool has no group.
        List<String> standard = StandardTools.all(30).stream().map(Tool::name)
                .filter(name -> !"view_image".equals(name))
                .toList();
        assertTrue(standard.containsAll(List.of("read_file", "run_command", "view_file")),
                "test premise: " + standard);
        for (String name : standard) {
            assertEquals(Optional.empty(), ToolGroup.of(name), name);
        }
        for (String name : List.of("update_plan", "ask_user_question", "use_skill", "read_skill_file")) {
            assertEquals(Optional.empty(), ToolGroup.of(name), name);
        }
        List<ToolSpec> kept = ToolGroup.visible(
                List.of(spec("read_file"), spec("run_command"), spec("update_plan"),
                        spec("browser_click"), spec("mcp__a__b")), Set.of(ToolGroup.values()));
        assertEquals(List.of("read_file", "run_command", "update_plan"), names(kept));
    }

    @Test
    void visibleDropsExactlyTheSwitchedOffGroupsAndKeepsTheOrder() {
        List<ToolSpec> belt = List.of(spec("read_file"), spec("browser_click"), spec("web_fetch"),
                spec("launch_list"), spec("generate_image"));
        assertEquals(belt, ToolGroup.visible(belt, Set.of()));
        assertEquals(List.of("read_file", "web_fetch", "generate_image"),
                names(ToolGroup.visible(belt, Set.of(ToolGroup.BROWSER, ToolGroup.LAUNCH))));
    }
}
