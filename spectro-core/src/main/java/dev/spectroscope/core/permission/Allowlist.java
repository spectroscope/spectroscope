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
 *   "read_file",                             // approve every read_file call
 *   "write_file#write",                      // a tool above read must say so
 *   "run_command#eval-execute:git status*",  // ... and may still scope its input
 *   "mcp__playwright__*#read"                // a whole server's READERS, nothing above
 * ]
 * </pre>
 *
 * <p><b>The entry grammar (card 199):</b> {@code <tool>[#<tier>][:<valuePrefix>]}.
 *
 * <ul>
 *   <li>The tool segment matches by name, or — when it ends in {@code *} — as a
 *       family prefix. A star anywhere else is a literal character.</li>
 *   <li>The tier is the entry's CEILING. A call passes only when the tool's own
 *       tier, resolved through the shipped {@link ToolTierMap}, sits at or below
 *       it. An entry that names no tier has a ceiling of {@link ToolTier#READ}.</li>
 *   <li>A wildcard entry MUST name its tier. Without one it matches nothing —
 *       widening a whole family is the one thing this file refuses to do by
 *       default, because a wildcard is exactly what someone writes to stop a
 *       prompt storm, and a name-only wildcard used to wave a Node-context eval
 *       through beside the screenshots.</li>
 *   <li>The value prefix is unchanged: the guarded input field must start with it.</li>
 * </ul>
 *
 * <p><b>Why a hash and not a second colon.</b> The colon is already spent: an
 * entry is parsed on its FIRST colon into a tool name plus a value prefix, and
 * the "remember this decision" path writes entries in exactly that shape
 * ({@code run_command:git status*}). Card 199 parks the final spelling as an
 * owner call and names {@code :read} as shorthand for the idea; the hash is what
 * this build implements. Only the separator is provisional — the semantics
 * above are the card's.
 *
 * <p>Anything not matched still goes through the interactive y/N question (CLI) or a
 * permission dialog (web). The decision remains auditable: the core emits
 * permission_decision events either way, and {@link #decide} answers the fuller
 * picture the gate audit sidecar writes. Lives in spectro-core so the CLI broker
 * and the server broker consult the SAME matcher.
 */
public final class Allowlist {

    /** The separator between the tool segment and the tier qualifier. */
    static final char TIER_MARK = '#';

    /**
     * One parsed entry.
     *
     * @param raw      the entry exactly as it stood in the settings file — the audit
     *                 trail names this, so a reader can find the line that approved a call
     * @param tool     the tool name (or family prefix, when {@code wildcard}) the rule applies to
     * @param wildcard whether {@code tool} is a family prefix rather than an exact name
     * @param ceiling  the widest tier this entry approves, or null when the entry is inert
     * @param prefix   the value prefix a guarded input must start with, or null to
     *                 approve every call of the tool
     * @param inertBecause why the entry approves nothing, or null when it is usable
     */
    record Rule(String raw, String tool, boolean wildcard, ToolTier ceiling,
                String prefix, String inertBecause) {

        /**
         * Parses one autoApprove entry: {@code <tool>[#<tier>][:<valuePrefix>]},
         * where a trailing "*" on the value is decoration (matching is always by
         * prefix anyway) and a trailing "*" on the TOOL segment makes it a family.
         *
         * <p>Every failure lands as an inert rule rather than an exception: a
         * sloppy settings file must not break the broker, and every wrong guess
         * about what an unreadable entry meant would be a widening.
         *
         * @param entry the raw entry string from the settings file
         * @return the parsed rule, tool name and prefix whitespace-stripped
         */
        static Rule parse(String entry) {
            int colon = entry.indexOf(':');
            String head = colon < 0 ? entry : entry.substring(0, colon);
            String prefix = null;
            if (colon >= 0) {
                prefix = entry.substring(colon + 1).strip();
                if (prefix.endsWith("*")) {
                    prefix = prefix.substring(0, prefix.length() - 1);
                }
            }
            int mark = head.indexOf(TIER_MARK);
            String tool = (mark < 0 ? head : head.substring(0, mark)).strip();
            String tierWord = mark < 0 ? null : head.substring(mark + 1).strip();

            ToolTier ceiling = ToolTier.READ;
            if (tierWord != null) {
                ceiling = ToolTier.parse(tierWord);
                if (ceiling == null) {
                    return new Rule(entry, tool, false, null, prefix,
                            "unknown tier \"" + tierWord + "\"");
                }
            }
            boolean wildcard = tool.endsWith("*");
            if (wildcard) {
                tool = tool.substring(0, tool.length() - 1);
                if (tierWord == null) {
                    return new Rule(entry, tool, true, null, prefix,
                            "a wildcard entry has to name its tier");
                }
                if (tool.isEmpty()) {
                    return new Rule(entry, tool, true, null, prefix,
                            "a bare \"*\" would approve every tool there is");
                }
            }
            if (tool.isEmpty()) {
                return new Rule(entry, tool, false, null, prefix, "the entry names no tool");
            }
            return new Rule(entry, tool, wildcard, ceiling, prefix, null);
        }

        /** Whether the entry's tool segment covers this call's tool name. */
        boolean namesTool(String toolName) {
            return wildcard ? toolName.startsWith(tool) : tool.equals(toolName);
        }
    }

    /**
     * What the gate decided and why — everything a gate audit line owes a reader.
     *
     * @param approved   whether the allowlist covered this call
     * @param entry      the raw entry that approved it, or null when none did
     * @param ceiling    the tier that entry allowed, or null on a refusal
     * @param toolTier   the tier the tool actually holds — named on a refusal too
     * @param source     where the tier came from: "builtin", "server:&lt;name&gt;" or "unmapped"
     * @param mapVersion the version of the tier map that answered
     */
    public record Verdict(boolean approved, String entry, ToolTier ceiling,
                          ToolTier toolTier, String source, String mapVersion) {}

    private final List<Rule> rules;
    private final ToolTierMap tiers;

    /**
     * Internal — instances come from {@link #fromEntries}.
     *
     * @param rules the already-parsed rules this matcher consults
     * @param tiers the tier map every tool name is resolved through
     */
    private Allowlist(List<Rule> rules, ToolTierMap tiers) {
        this.rules = rules;
        this.tiers = tiers;
    }

    /**
     * Builds the matcher from raw {@code autoApprove} entries against the shipped
     * tier map; null and blank entries are dropped rather than rejected — a sloppy
     * settings file must not break the broker.
     *
     * @param entries the raw autoApprove strings from the settings hierarchy
     * @return an allowlist matching exactly those entries
     */
    public static Allowlist fromEntries(List<String> entries) {
        return fromEntries(entries, ToolTierMap.shipped());
    }

    /**
     * The variant that names the tier map — tests pin a map of their own so a
     * later release's map cannot silently change what they prove.
     *
     * @param entries the raw autoApprove strings from the settings hierarchy
     * @param tiers   the tier map every tool name is resolved through
     * @return an allowlist matching exactly those entries
     */
    public static Allowlist fromEntries(List<String> entries, ToolTierMap tiers) {
        return new Allowlist(entries.stream()
                .filter(entry -> entry != null && !entry.isBlank())
                .map(Rule::parse)
                .toList(), tiers);
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
        return decide(request).approved();
    }

    /**
     * The same decision as {@link #allows}, with everything the gate audit needs:
     * the entry that approved the call, the ceiling it named, the tier the tool
     * actually holds and the map version that said so. A refusal still carries the
     * tool's tier and its source — "nobody approved this, and here is what it is".
     *
     * @param request the pending permission request
     * @return the verdict; never null
     */
    public Verdict decide(PermissionRequest request) {
        ToolTierMap.Resolution resolved = tiers.resolve(request.name());
        for (Rule rule : rules) {
            if (rule.ceiling() == null) {
                continue;   // inert: unknown tier, or a wildcard that named none
            }
            if (!rule.namesTool(request.name())) {
                continue;
            }
            if (!resolved.tier().atMost(rule.ceiling())) {
                continue;   // the entry is real, the tool is simply above it
            }
            if (rule.prefix() != null
                    && !guardedValue(request).map(v -> v.startsWith(rule.prefix())).orElse(false)) {
                continue;
            }
            return new Verdict(true, rule.raw(), rule.ceiling(),
                    resolved.tier(), resolved.source(), resolved.mapVersion());
        }
        return new Verdict(false, null, null,
                resolved.tier(), resolved.source(), resolved.mapVersion());
    }

    /**
     * Every entry as the settings UI shows it: the raw line, what it parsed to,
     * and — when it approves nothing — the reason in one sentence. Reading only;
     * the page renders what the gate decided and never re-decides it.
     *
     * @return one reading per entry, in file order
     */
    public List<EntryReading> readings() {
        return rules.stream()
                .map(rule -> new EntryReading(rule.raw(), rule.tool(), rule.wildcard(),
                        rule.ceiling() == null ? null : rule.ceiling().wireName(),
                        rule.wildcard() ? null : tiers.resolve(rule.tool()).tier().wireName(),
                        rule.prefix(), rule.inertBecause()))
                .toList();
    }

    /**
     * One allowlist entry, read out for a settings page.
     *
     * @param raw          the entry exactly as it stands in the settings file
     * @param tool         the tool name, or the family prefix when {@code wildcard}
     * @param wildcard     whether the entry covers a family rather than one name
     * @param tier         the ceiling's wire name, or null when the entry is inert
     * @param toolTier     the tier the NAMED tool actually holds in the shipped map,
     *                     or null for a wildcard (which names a family, not a tool) —
     *                     this is the fact the settings page shows so that an entry
     *                     nobody remembers writing becomes something a reader can weigh
     * @param valuePrefix  the guarded value prefix, or null when the entry has none
     * @param inertBecause why the entry approves nothing, or null when it is usable
     */
    public record EntryReading(String raw, String tool, boolean wildcard, String tier,
                               String toolTier, String valuePrefix, String inertBecause) {}

    /**
     * The autoApprove rule a "remember/persist this decision" click should store.
     *
     * <p>The remembered entry carries the TIER of the tool that was just approved,
     * because the user approving one call is the deliberate act the read-by-default
     * rule asks for — without the stamp, remembering a write would silently store
     * an entry that no longer approves the thing the user just said yes to.
     *
     * <p>Risky tools stay prefix-scoped so one click never blanket-approves every call:
     * run_command and the goal check by their first token ("run_command#eval-execute:git*",
     * "goal_check#eval-execute:./gradlew*"), the path/url tools by
     * their full value ("write_file#write:docs/a.md*", "edit_file#write:src/Main.java*",
     * "web_fetch#read:https://example.com*", "browse_page#write:https://example.com*");
     * every other tool (web_search included — queries vary every call) remembers
     * its bare name plus its tier.
     * The result is a string {@link #fromEntries} and {@code Rule.parse} already
     * understand.
     *
     * @param toolName the tool the user just approved for good
     * @param input    the approved call's input — the guarded field's value becomes the prefix
     * @return the entry to persist into the settings' autoApprove list
     */
    public static String rememberRule(String toolName, JsonNode input) {
        String qualified = toolName + TIER_MARK
                + ToolTierMap.shipped().resolve(toolName).tier().wireName();
        String field = guardedField(toolName);
        if (field == null) {
            return qualified;
        }
        String value = input.path(field).asText("").strip();
        // A command scopes by its first token; path/url tools by the full value.
        // Keyed on the FIELD and not on the tool name: card 267 added a second
        // caller of the same /bin/sh (goal_check) and a switch on the name would
        // have remembered it bare — one click blanket-approving every future
        // check, which is the thing the run_command scoping exists to prevent.
        if ("command".equals(field) && !value.isEmpty()) {
            value = value.split("\\s+")[0];
        }
        return value.isEmpty() ? qualified : qualified + ":" + value + "*";
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
            // goal_check is not a tool and is in no registry (Agent.GOAL_CHECK_GATE),
            // but it asks this gate with a shell line in a field named "command",
            // so it is scoped exactly as run_command is. The alternative, measured
            // in card 267's review, is a persisted `goal_check#eval-execute` that
            // approves every command an operator states from then on.
            case "run_command", "goal_check" -> "command";
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
