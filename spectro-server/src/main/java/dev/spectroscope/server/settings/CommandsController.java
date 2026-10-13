package dev.spectroscope.server.settings;

import dev.spectroscope.core.commands.CommandList;

import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RestController;

import java.util.List;

/**
 * The chat commands for the web (card 554, owner option A): the web chat's
 * {@code /help}, its slash picker and the Skills and Commands page are built
 * from this answer, and the terminal REPL prints the same list from the same
 * resource.
 *
 * <p>Fenced like every other {@code /api} path by {@code ApiLocalFence}; no
 * {@code @CrossOrigin}, matching the settings controllers beside it.</p>
 */
@RestController
public class CommandsController {

    /** Stateless: the list is a static resource of the core jar. */
    public CommandsController() {
    }

    /**
     * Every row of the list, in its order, the rows another card owns included
     * ({@code wired} false), so the web can tell a reserved name from an
     * unknown one.
     *
     * @return the list
     */
    @GetMapping("/api/commands")
    public List<CommandList.Command> commands() {
        return CommandList.all();
    }
}
