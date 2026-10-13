package dev.spectroscope.server.settings;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import dev.spectroscope.core.commands.CommandList;
import dev.spectroscope.server.web.ApiLocalFence;
import org.junit.jupiter.api.Test;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.MvcResult;
import org.springframework.test.web.servlet.setup.MockMvcBuilders;

import java.util.List;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

/**
 * Card 554: {@code GET /api/commands} serves the one command list to the web
 * (owner option A), behind the same local fence as every {@code /api} path.
 */
class CommandsControllerTest {

    private static final ObjectMapper JSON = new ObjectMapper();

    private final MockMvc mvc = MockMvcBuilders.standaloneSetup(new CommandsController())
            .addFilters(new ApiLocalFence()).build();

    @Test
    void theRouteAnswersEveryRowWithEveryFieldTheWebDraws() throws Exception {
        MvcResult result = mvc.perform(get("http://localhost/api/commands")).andExpect(status().isOk()).andReturn();
        JsonNode wire = JSON.readTree(result.getResponse().getContentAsString());

        assertTrue(wire.isArray());
        assertFalse(CommandList.all().isEmpty(), "an empty list passes every other assertion here");
        assertEquals(CommandList.all().size(), wire.size(), "the route filtered the list");
        for (int i = 0; i < wire.size(); i++) {
            JsonNode row = wire.get(i);
            CommandList.Command c = CommandList.all().get(i);
            assertEquals(c.id(), row.path("id").asText(), "the order is the list's order");
            for (String field : List.of("id", "name", "aliases", "takesArgs", "group", "surfaces", "developerOnly",
                    "wired", "help")) {
                assertTrue(row.has(field), c.id() + " lost " + field + " on the wire");
            }
            assertEquals(c.help().en(), row.path("help").path("en").asText());
            assertEquals(c.wired(), row.path("wired").asBoolean());
        }
        JsonNode run = wire.findParents("id").stream().filter(r -> "run-with-playbook".equals(r.path("id").asText()))
                .findFirst().orElseThrow();
        assertEquals("playbook run", run.path("aliases").get(0).asText());
        assertTrue(run.path("takesArgs").asBoolean());
    }

    @Test
    void aReboundHostReadsNoCommandList() throws Exception {
        mvc.perform(get("http://evil.example/api/commands")).andExpect(status().isNotFound());
    }
}
