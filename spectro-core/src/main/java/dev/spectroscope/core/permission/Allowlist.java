package dev.spectroscope.core.permission;

import com.fasterxml.jackson.databind.JsonNode;
import dev.spectroscope.core.events.RunEvent.PermissionRequest;

import java.util.List;
import java.util.Optional;

/**
 * The permission allowlist from the settings hierarchy (additive,
 * Claude-Code style). Entries come from {@code autoApprove} in
 * ~/.spectro/config.json or the project's .spectro/settings.json:
 *
 * <pre>
 * "autoApprove": [
 *   "write_file",                 // approve every write_file call
 *   "run_command:git status*",    // approve run_command when the command starts with "git status"
 *   "run_command:ls*"
 * ]
 * </pre>
 *
 * Anything not matched still goes through the interactive y/N question (CLI) or a
 * permission dialog (web). The decision remains auditable: the core emits
 * permission_decision events either way. Lives in spectro-core so the CLI broker and
 * the server broker consult the SAME matcher.
 */
public final class Allowlist {

    /**
     * One parsed entry: a tool name plus an optional value prefix.
     *
     * @param tool   the tool name the rule applies to (e.g. "run_command")
     * @param prefix the value prefix a guarded input must start with, or null to
     *               approve every call of the tool
     */
    private record Rule(String tool, String prefix) {

        /**
         * Parses one autoApprove entry — "tool" alone or "tool:prefix", where a
         * trailing "*" is decoration (matching is always by prefix anyway).
         *
         * @param entry the raw entry string from the settings file
         * @return the parsed rule, tool name and prefix whitespace-stripped
         */
        static Rule parse(String entry) {
            int colon = entry.indexOf(':');
            if (colon < 0) {
                return new Rule(entry.strip(), null);
            }
            String prefix = entry.substring(colon + 1).strip();
            if (prefix.endsWith("*")) {
                prefix = prefix.substring(0, prefix.length() - 1);
            }
            return new Rule(entry.substring(0, colon).strip(), prefix);
        }
    }

    private final List<Rule> rules;

    /**
     * Internal — instances come from {@link #fromEntries}.
     *
     * @param rules the already-parsed rules this matcher consults
     */
    private Allowlist(List<Rule> rules) {
        this.rules = rules;
    }

    /**
     * Builds the matcher from raw {@code autoApprove} entries; null and blank
     * entries are dropped rather than rejected — a sloppy settings file must not
     * break the broker.
     *
     * @param entries the raw autoApprove strings from the settings hierarchy
     * @return an allowlist matching exactly those entries
     */
    public static Allowlist fromEntries(List<String> entries) {
        return new Allowlist(entries.stream()
                .filter(entry -> entry != null && !entry.isBlank())
                .map(Rule::parse)
                .toList());
    }

    /**
     * Whether any rule is configured at all — an empty allowlist lets a broker
     * skip the matching entirely.
     *
     * @return true when no autoApprove entry survived parsing
     */
    public boolean isEmpty() {
        return rules.isEmpty();
    }

    /**
     * True when a rule covers this request — the broker then approves silently.
     *
     * @param request the pending permission request (tool name plus input)
     * @return true if any rule matches; anything unmatched still goes through the
     *         interactive question
     */
    public boolean allows(PermissionRequest request) {
        return rules.stream().anyMatch(rule -> matches(rule, request));
    }

    /**
     * The autoApprove rule a "remember/persist this decision" click should store.
     * Risky tools stay prefix-scoped so one click never blanket-approves every call:
     * run_command by its first token ("run_command:git*"), the path/url tools by
     * their full value ("write_file:docs/a.md*", "edit_file:src/Main.java*",
     * "web_fetch:https://example.com*", "browse_page:https://example.com*");
     * every other tool (web_search included — queries vary every call) remembers
     * its bare name.
     * The result is a string {@link #fromEntries} and {@code Rule.parse} already
     * understand.
     *
     * @param toolName the tool the user just approved for good
     * @param input    the approved call's input — the guarded field's value becomes the prefix
     * @return the entry to persist into the settings' autoApprove list
     */
    public static String rememberRule(String toolName, JsonNode input) {
        String field = guardedField(toolName);
        if (field == null) {
            return toolName;
        }
        String value = input.path(field).asText("").strip();
        // A command scopes by its first token; path/url tools by the full value.
        if ("run_command".equals(toolName) && !value.isEmpty()) {
            value = value.split("\\s+")[0];
        }
        return value.isEmpty() ? toolName : toolName + ":" + value + "*";
    }

    /**
     * One rule against one request: the tool name must be equal; a prefix rule
     * additionally requires the guarded input value to start with the prefix.
     *
     * @param rule    the parsed autoApprove entry
     * @param request the pending permission request
     * @return true when the rule covers the request
     */
    private static boolean matches(Rule rule, PermissionRequest request) {
        if (!rule.tool().equals(request.name())) {
            return false;
        }
        if (rule.prefix() == null) {
            return true;
        }
        return guardedValue(request).map(value -> value.startsWith(rule.prefix())).orElse(false);
    }

    /**
     * The input field a prefix rule guards, per tool — the ONE place to extend
     * when a new guarded tool arrives; remembering and matching both read it,
     * so a remembered rule can never go dark on the matching side.
     *
     * @param toolName the tool whose input is being scoped
     * @return the input field a prefix rule guards, or null for tools remembered by bare name
     */
    private static String guardedField(String toolName) {
        return switch (toolName) {
            case "run_command" -> "command";
            case "write_file", "edit_file" -> "path";
            case "web_fetch", "browse_page" -> "url";
            default -> null;
        };
    }

    /**
     * Extracts the value of the request's guarded field for prefix matching.
     *
     * @param request the pending permission request
     * @return the guarded field's value, or empty when the tool has none (or the value is blank)
     */
    private static Optional<String> guardedValue(PermissionRequest request) {
        String field = guardedField(request.name());
        if (field == null) {
            return Optional.empty();
        }
        String value = request.input().path(field).asText("");
        return value.isEmpty() ? Optional.empty() : Optional.of(value);
    }
}
