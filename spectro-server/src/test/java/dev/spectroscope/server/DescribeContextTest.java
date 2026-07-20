package dev.spectroscope.server;

import dev.spectroscope.core.config.SpectroConfig;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import java.nio.file.Path;
import java.util.Map;
import java.util.function.Function;
import java.util.stream.Collectors;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * GET /api/context must describe the live tool set from the REAL tool objects —
 * the old hand-written literals had drifted from the tools' descriptions and
 * update_plan was missing from the list entirely.
 */
class DescribeContextTest {

    @Test
    void introspectionListsUpdatePlanAndReadsTheRealDescriptions(@TempDir Path cwd) {
        SpectroConfig config = SpectroConfig.load(SpectroConfig.Overrides.none(), cwd);

        ContextInfo context = ContextDescriber.describe(config, cwd);
        Map<String, ContextInfo.ToolInfo> byName = context.tools().stream()
                .collect(Collectors.toMap(ContextInfo.ToolInfo::name, Function.identity()));

        assertTrue(byName.containsKey("update_plan"),
                "the plan tool must appear in the introspection list");
        assertEquals(new dev.spectroscope.core.tools.UpdatePlanTool().description(),
                byName.get("update_plan").description());
        assertEquals(new dev.spectroscope.core.image.GenerateImageTool(() -> null, null).description(),
                byName.get("generate_image").description(),
                "introspection reads the real tool, not a drifted literal");
        assertEquals(new dev.spectroscope.core.tools.WebFetchTool(url -> null).description(),
                byName.get("web_fetch").description());
        assertTrue(byName.get("web_fetch").needsPermission());
    }

    @Test
    void introspectionListsWebSearchWithItsActiveTierAndBrowsePage(@TempDir Path cwd) {
        SpectroConfig config = SpectroConfig.load(SpectroConfig.Overrides.none(), cwd);

        ContextInfo context = ContextDescriber.describe(config, cwd);
        Map<String, ContextInfo.ToolInfo> byName = context.tools().stream()
                .collect(Collectors.toMap(ContextInfo.ToolInfo::name, Function.identity()));

        assertTrue(byName.containsKey("web_search"), "web_search must appear in the list");
        assertEquals(dev.spectroscope.core.web.WebSearchTool.fromEnv(System.getenv()).description(),
                byName.get("web_search").description(),
                "the introspection names the ACTIVE search tier, whatever the env selects");
        assertTrue(byName.get("web_search").needsPermission());

        assertTrue(byName.containsKey("browse_page"), "browse_page must appear in the list");
        assertEquals(new dev.spectroscope.core.web.BrowsePageTool().description(),
                byName.get("browse_page").description());
        assertTrue(byName.get("browse_page").needsPermission());
    }
}
