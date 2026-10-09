package dev.spectroscope.server.session;

import dev.spectroscope.core.ToolGroup;
import org.junit.jupiter.api.Test;

import java.util.EnumSet;
import java.util.List;
import java.util.Map;
import java.util.Set;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * Card 466: the gear's hint lists a tool under a group exactly when switching
 * that group off hides the tool. Both answers come from
 * {@link ToolGroup#of}, so a name two groups' rules could claim is listed
 * once, under the group the filter uses.
 */
class ToolGroupCatalogTest {

    @Test
    void theHintAndTheFilterShareOneRule() {
        // "web_image" matches the web rule (web_ prefix) and the images rule
        // (_image suffix). No such tool exists today; the point is the tie.
        List<String> names = List.of("web_image", "browser_click", "read_file", "mcp__a__web_fetch");
        List<Map<String, Object>> groups = ToolGroupCatalog.groups(names);

        for (Map<String, Object> entry : groups) {
            ToolGroup group = ToolGroup.named((String) entry.get("name")).orElseThrow();
            @SuppressWarnings("unchecked")
            List<String> listed = (List<String>) entry.get("tools");
            Set<ToolGroup> off = EnumSet.of(group);
            for (String name : names) {
                assertThat(listed.contains(name))
                        .as(name + " listed under " + group.wireName()
                                + " exactly when switching it off hides the tool")
                        .isEqualTo(ToolGroup.switchedOff(name, off));
            }
        }
        long listings = groups.stream()
                .filter(entry -> ((List<?>) entry.get("tools")).contains("web_image")).count();
        assertThat(listings).as("web_image is listed once").isEqualTo(1);
    }
}
