package dev.spectroscope.server.session;

import dev.spectroscope.core.config.SpectroConfig;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import java.nio.file.Path;
import java.util.List;
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
    void introspectionListsTheAskBecauseTheLiveBeltCarriesIt(@TempDir Path cwd) {
        // Card 265, and the same failure this whole class exists to stop: the ask
        // is registered in buildAgentOnce beside update_plan, so a System-Context
        // panel that does not name it describes a belt the session does not have.
        // The seam here is Asker.none() — describing a tool is not driving one,
        // and this endpoint has no session and therefore nobody to ask.
        SpectroConfig config = SpectroConfig.load(SpectroConfig.Overrides.none(), cwd);

        ContextInfo context = ContextDescriber.describe(config, cwd);
        Map<String, ContextInfo.ToolInfo> byName = context.tools().stream()
                .collect(Collectors.toMap(ContextInfo.ToolInfo::name, Function.identity()));

        assertTrue(byName.containsKey("ask_user_question"),
                "the ask must appear in the introspection list");
        assertEquals(new dev.spectroscope.core.tools.AskUserQuestionTool(
                        dev.spectroscope.core.Asker.none()).description(),
                byName.get("ask_user_question").description(),
                "introspection reads the real tool, not a drifted literal");
        assertEquals(false, byName.get("ask_user_question").needsPermission());
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
    void introspectionListsTheSevenBrowserToolsWithTheirRealDescriptions(@TempDir Path cwd) {
        // Card 201's family was registered in buildAgentOnce and never added
        // here, so the tab under-reported the main agent's tool set by seven.
        // The same failure the class was written against: not a drifted string
        // this time, a missing family.
        SpectroConfig config = SpectroConfig.load(SpectroConfig.Overrides.none(), cwd);

        ContextInfo context = ContextDescriber.describe(config, cwd);
        Map<String, ContextInfo.ToolInfo> byName = context.tools().stream()
                .collect(Collectors.toMap(ContextInfo.ToolInfo::name, Function.identity()));

        // Read off a REAL family, exactly like web_fetch and browse_page above:
        // a literal list of seven names here would be the drift this test exists
        // to catch, one indirection later.
        List<dev.spectroscope.core.tools.Tool> browser =
                new dev.spectroscope.core.browser.BrowserTools(
                        dev.spectroscope.core.browser.BrowserFace::none, () -> null, null).all();
        assertEquals(7, browser.size(), "test premise: card 201 ships seven browser tools");
        for (dev.spectroscope.core.tools.Tool tool : browser) {
            assertTrue(byName.containsKey(tool.name()),
                    tool.name() + " is registered for every session and must appear in the list");
            assertEquals(tool.description(), byName.get(tool.name()).description(),
                    "introspection reads the real tool, not a drifted literal");
            assertEquals(tool.needsPermission(), byName.get(tool.name()).needsPermission(),
                    tool.name() + " must carry the gate flag the live registry gives it");
        }
    }

    @Test
    void introspectionListsTheFiveLaunchToolsWithTheirRealDescriptions(@TempDir Path cwd) {
        // Card 202's family was the LAST hand-kept gap in this list: the old
        // javadoc disclosed the under-report instead of closing it. Since the
        // live belt registers the five for EVERY session (the supervisor is the
        // connection's own field, unconditionally), a reader told otherwise is
        // told something false — same reasoning as the browser family above.
        SpectroConfig config = SpectroConfig.load(SpectroConfig.Overrides.none(), cwd);

        ContextInfo context = ContextDescriber.describe(config, cwd);
        Map<String, ContextInfo.ToolInfo> byName = context.tools().stream()
                .collect(Collectors.toMap(ContextInfo.ToolInfo::name, Function.identity()));

        // Read off the REAL family — a literal five-name list here would be the
        // drift this class exists to catch. The supervisor never starts
        // anything: name, description and gate flag are the tools' own.
        List<dev.spectroscope.core.tools.Tool> launch =
                new dev.spectroscope.core.launch.LaunchTools(
                        new dev.spectroscope.core.launch.LaunchSupervisor((host, port) -> false),
                        dev.spectroscope.core.browser.BrowserFace::none, () -> null).all();
        assertEquals(5, launch.size(), "test premise: card 202 ships five launch tools");
        for (dev.spectroscope.core.tools.Tool tool : launch) {
            assertTrue(byName.containsKey(tool.name()),
                    tool.name() + " is registered for every session and must appear in the list");
            assertEquals(tool.description(), byName.get(tool.name()).description(),
                    "introspection reads the real tool, not a drifted literal");
            assertEquals(tool.needsPermission(), byName.get(tool.name()).needsPermission(),
                    tool.name() + " must carry the gate flag the live registry gives it");
        }

        // And in registration order: after the browser family, before update_plan
        // — exactly where registerSettingsTools puts the family live.
        List<String> names = context.tools().stream().map(ContextInfo.ToolInfo::name).toList();
        assertTrue(names.indexOf("browser_resize") < names.indexOf("launch_list"),
                "the launch family follows the browser family, got: " + names);
        assertTrue(names.indexOf("launch_logs") < names.indexOf("update_plan"),
                "the launch family is registered before update_plan, got: " + names);
    }

    @Test
    void theBrowserFamilySitsWhereTheLiveRegistryPutsIt(@TempDir Path cwd) {
        // "in registration order" is a promise the list makes; buildAgentOnce
        // registers the family after browse_page and before update_plan.
        SpectroConfig config = SpectroConfig.load(SpectroConfig.Overrides.none(), cwd);

        List<String> names = ContextDescriber.describe(config, cwd).tools().stream()
                .map(ContextInfo.ToolInfo::name)
                .toList();

        assertTrue(names.indexOf("browse_page") < names.indexOf("browser_navigate"),
                "the browser family is registered after browse_page, got: " + names);
        assertTrue(names.indexOf("browser_resize") < names.indexOf("update_plan"),
                "the browser family is registered before update_plan, got: " + names);
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
