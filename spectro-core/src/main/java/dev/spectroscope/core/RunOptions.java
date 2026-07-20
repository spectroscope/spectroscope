package dev.spectroscope.core;

import dev.spectroscope.core.events.RunEvent.Attachment;

import java.util.List;

/**
 * Per-run options. {@code attachments} is optional; null for a text-only run.
 *
 * @param signal      cooperative cancel handle; null lets the run create its own
 * @param attachments images riding along with the prompt; null or empty
 *                    for a text-only run
 */
public record RunOptions(CancelSignal signal, List<Attachment> attachments) {}
