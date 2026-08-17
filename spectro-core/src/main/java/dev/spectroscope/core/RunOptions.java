package dev.spectroscope.core;

import dev.spectroscope.core.events.RunEvent.Attachment;

import java.util.List;

/**
 * Per-run options. {@code attachments} is optional; null for a text-only run.
 *
 * @param signal         cooperative cancel handle; null lets the run create its own
 * @param attachments    images riding along with the prompt; null or empty
 *                       for a text-only run
 * @param promptForModel the prompt as the MODEL should read it (card 247: the
 *                       slash-skill expansion) — null means the prompt itself.
 *                       The record and the transcript always keep the literal
 *                       prompt; only the provider request carries this reading
 */
public record RunOptions(CancelSignal signal, List<Attachment> attachments, String promptForModel) {

    /**
     * The pre-card-247 shape: no separate model reading.
     *
     * @param signal      cooperative cancel handle; null lets the run create its own
     * @param attachments images riding along with the prompt; null or empty
     */
    public RunOptions(CancelSignal signal, List<Attachment> attachments) {
        this(signal, attachments, null);
    }
}
