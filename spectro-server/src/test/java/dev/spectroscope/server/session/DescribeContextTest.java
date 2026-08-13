package dev.spectroscope.server.session;

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
        assertEquals(dev.spectroscope.core.web.WebSearchTool.fromConfig(config).description(),
                byName.get("web_search").description(),
                "the introspection names the ACTIVE search tier, whatever the configuration selects");
        assertTrue(byName.get("web_search").needsPermission());

        assertTrue(byName.containsKey("browse_page"), "browse_page must appear in the list");
        assertEquals(new dev.spectroscope.core.web.BrowsePageTool().description(),
                byName.get("browse_page").description());
        assertTrue(byName.get("browse_page").needsPermission());
    }

    @Test
    void introspectionDescribesTheConfigItWasHandedAndNotASecondLoad(@TempDir Path cwd)
            throws java.io.IOException {
        // Review finding F5 of card 203: mainAgentTools called SpectroConfig.load()
        // a second time and threw away the config the caller had already resolved.
        // That is invisible while every caller builds an identical config — and the
        // day one passes a session scope, an override or another cwd, the
        // introspection tab names a different search tier than the session runs.
        // The address below reaches the config through the launch-dir layer of THIS
        // cwd, which a process-wide load never sees.
        Path settings = cwd.resolve(SpectroConfig.PROJECT_SETTINGS);
        java.nio.file.Files.createDirectories(settings.getParent());
        java.nio.file.Files.writeString(settings, "{\"searxngUrl\": \"http://handed-in.example:8888\"}");
        SpectroConfig config = SpectroConfig.load(SpectroConfig.Overrides.none(), cwd);
        assertEquals("http://handed-in.example:8888", config.searxngUrl(), "test premise");

        ContextInfo context = ContextDescriber.describe(config, cwd);

        String webSearch = context.tools().stream()
                .filter(tool -> tool.name().equals("web_search"))
                .findFirst().orElseThrow().description();
        assertTrue(webSearch.contains("http://handed-in.example:8888"),
                "the tab must describe the tier of the config it was given, got: " + webSearch);
    }
}
