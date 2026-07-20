package dev.spectroscope.core.config;

import com.fasterxml.jackson.annotation.JsonIgnoreProperties;

/**
 * One entry of the {@code hooks} config block — an external shell command spectroscope
 * runs around a tool call (Claude-Code style). {@code event} is
 * {@code "pre_tool_use"} or {@code "post_tool_use"}; {@code matcher} is a
 * tool-name glob (default {@code "*"}); {@code command} is a shell string.
 *
 * <p>Hook commands come only from config (the settings hierarchy), never from
 * tool input — a pre_tool_use hook is arbitrary shell that runs BEFORE the
 * permission gate, so it must never be model-controlled.</p>
 *
 * @param matcher        tool-name glob the hook applies to; null or blank means {@code "*"}
 * @param event          {@code "pre_tool_use"} or {@code "post_tool_use"} — anything else is rejected
 * @param command        the shell command line spectroscope executes around the tool call
 * @param timeoutSeconds kill-after budget for the hook process; null or non-positive
 *                       falls back to the runner default
 */
@JsonIgnoreProperties(ignoreUnknown = true)
public record HookConfig(String matcher, String event, String command, Integer timeoutSeconds) {

    /** A typo like {@code "pre-tool-use"} would otherwise match no dispatch branch
     *  and the guard would silently never run — malformed config fails loudly. */
    public HookConfig {
        if (!"pre_tool_use".equals(event) && !"post_tool_use".equals(event)) {
            throw new IllegalArgumentException("Unknown hook event \"" + event
                    + "\" — use \"pre_tool_use\" or \"post_tool_use\".");
        }
    }

    /** The tool-name glob, defaulting to {@code "*"} (matches every tool).
     *  @return the configured matcher, or {@code "*"} when unset or blank */
    public String matcherOrDefault() {
        return matcher == null || matcher.isBlank() ? "*" : matcher;
    }

    /** The per-hook timeout in seconds, or {@code fallback} when unset/non-positive.
     *  @param fallback the runner-wide default to fall back on
     *  @return the effective timeout in seconds */
    public long timeoutOrDefault(long fallback) {
        return timeoutSeconds == null || timeoutSeconds <= 0 ? fallback : timeoutSeconds;
    }
}
