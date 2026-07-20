package dev.spectroscope.core.tools;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import dev.spectroscope.core.CancelSignal;
import dev.spectroscope.core.tools.Tool.ToolContext;
import org.junit.jupiter.api.Test;

import java.lang.reflect.Proxy;
import java.nio.file.Path;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * The registry is the autologging injection point for tools :
 * register() hands every tool back Logged-wrapped, and the wrap is
 * behavior-invisible — name, schema, gate flag and execute forward untouched.
 */
class ToolRegistryTest {

    private static final ObjectMapper JSON = new ObjectMapper();

    private static final class PlainTool implements Tool {
        public String name() { return "plain"; }
        public String description() { return "a plain tool"; }
        public JsonNode inputSchema() { return JSON.createObjectNode(); }
        public boolean needsPermission() { return true; }
        public String execute(JsonNode input, ToolContext context) {
            return "ran: " + input.path("v").asText();
        }
    }

    @Test
    void registerInjectsTheAutologgingProxyBehaviorUntouched() {
        ToolRegistry registry = new ToolRegistry();
        registry.register(new PlainTool());

        Tool fetched = registry.get("plain").orElseThrow();

        assertTrue(Proxy.isProxyClass(fetched.getClass()),
                "the registry hands out the Logged proxy");
        assertEquals("plain", fetched.name());
        assertEquals("a plain tool", fetched.description());
        assertTrue(fetched.needsPermission());
        assertEquals("ran: 7", fetched.execute(JSON.createObjectNode().put("v", "7"),
                new ToolContext(Path.of("."), new CancelSignal())));
    }
}
