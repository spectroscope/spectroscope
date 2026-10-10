package dev.spectroscope.core.playbook.run;

import dev.spectroscope.core.Asker;
import dev.spectroscope.core.CancelSignal;
import dev.spectroscope.core.PermissionBroker;
import dev.spectroscope.core.events.RunEvent;
import dev.spectroscope.core.playbook.Playbook;
import dev.spectroscope.core.provider.LlmProvider;

import java.nio.file.Path;

/** What a playbook run needs from the face that hosts it. The server implements it per session. */
public interface PlaybookHost {

    /** @return the session's working folder; documents and commands resolve against it */
    Path workspace();

    /** @param event written to the session file, then sent to the socket */
    void emit(RunEvent event);

    /**
     * Runs one main agent turn and blocks until its run ends.
     *
     * @param recordPrompt what the session file shows as the prompt
     * @param modelPrompt  what the model receives; equal to recordPrompt when nothing is inlined
     * @param signal       the step's signal
     * @return the main run's stop reason and its last turn's text
     */
    ChatTurn chatTurn(String recordPrompt, String modelPrompt, CancelSignal signal);

    /** @return the chat's provider and model now */
    Playbook.ModelRef chatModel();

    /** @param ref the model the chat switches to; @return null when switched, else the refusal */
    String switchChat(Playbook.ModelRef ref);

    /**
     * @param ref a provider and model the playbook names
     * @return a provider labelled with its name for run_start
     * @throws IllegalStateException with the reason when it cannot be built
     */
    LlmProvider providerFor(Playbook.ModelRef ref);

    /** @param provider a provider name; @return the registry row after a bounded check */
    Probe probe(String provider);

    /** @param provider a provider name; @return local, cloud or builtin, without a request */
    String kindOf(String provider);

    /** @param mode the step's permission, or null to clear */
    void permissionFloor(String mode);

    /** @return the session's broker */
    PermissionBroker broker();

    /** @return the session's asker, or null when nobody can be asked */
    Asker asker();

    /**
     * @param stopReason the stop reason of the main run_end
     * @param lastText   the main agent's last turn
     */
    record ChatTurn(String stopReason, String lastText) {
    }
}
