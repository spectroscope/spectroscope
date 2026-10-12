package dev.spectroscope.core.messaging;

import dev.spectroscope.core.tools.Tool;

import java.util.List;

/**
 * The two messaging tools of card 503, in the order every face registers
 * them: {@code send_message}, then {@code list_agents}.
 */
public final class MessagingTools {

    private MessagingTools() {
    }

    /**
     * @param seat the face the calling agent sits on
     * @return send_message and list_agents on that seat
     */
    public static List<Tool> forSeat(MessagingSeat seat) {
        return List.of(new SendMessageTool(seat), new ListAgentsTool(seat));
    }
}
