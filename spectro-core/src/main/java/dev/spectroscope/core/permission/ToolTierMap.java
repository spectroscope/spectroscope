package dev.spectroscope.core.permission;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;

import java.io.IOException;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.util.LinkedHashMap;
import java.util.Map;

/**
 * What tier each tool holds — the product's own answer, shipped with the jar.
 *
 * <p><b>Why the product and not the protocol.</b> Both MCP transports pin
 * revision {@code 2024-11-05} ({@code mcp/StdioTransport}, {@code
 * mcp/HttpSseTransport}), and that revision has no tool annotations at all:
 * {@code readOnlyHint} and its siblings arrived in {@code 2025-03-26}. The
 * descriptor the harness parses holds name, description and inputSchema and
 * drops unknown fields in silence. A server that sent an annotation today would
 * be sending it into a void. Reading a tier off the handshake is therefore not
 * a thing that can be done here, so the tier is a shipped, versioned, reviewed
 * data file: {@code resources/permission/tool-tiers.json}.
 *
 * <p><b>The one rule everything else follows from:</b> a tool the map does not
 * name is {@link ToolTier#EVAL_EXECUTE}, and so is every tool of a server the
 * map does not know. Nothing outside this file may lower a tier — {@link
 * #resolve(String, ToolTier)} takes the WIDER of the map and the hint, so a
 * later revision's annotation can raise a tool and can never sink one.
 *
 * <p>The cost is honest and worth naming: an updated server produces prompts on
 * the day it updates, and the fix is an entry in the next release, not a config
 * edit on the user's machine.
 */
public final class ToolTierMap {

    private static final ObjectMapper JSON = new ObjectMapper();

    /** The classpath location of the shipped map. */
    static final String RESOURCE = "/permission/tool-tiers.json";

    /** Keys inside the data file that carry prose, not a tier. */
    private static final String COMMENT_KEY = "_comment";

    /** The prefix that marks a tool name as coming from an MCP server. */
    private static final String MCP_PREFIX = "mcp__";

    /** The separator between the server segment and the remote tool name. */
    private static final String MCP_SEPARATOR = "__";

    /** The shipped map, parsed once — the file is in the jar and cannot change under us. */
    private static final ToolTierMap SHIPPED = load();

    private final int schemaVersion;
    private final String mapVersion;
    private final Map<String, ToolTier> builtin;
    private final Map<String, Map<String, ToolTier>> servers;

    /**
     * How one tool name resolved. Carried as a record rather than a bare tier
     * because the audit trail owes a reader all four fields: which tool, which
     * tier, which section decided it, and which version of the map that was.
     *
     * @param toolName   the tool as the model addresses it
     * @param tier       the resolved tier — never null
     * @param source     "builtin", "server:&lt;name&gt;" or "unmapped"
     * @param mapVersion the version of the map that answered
     */
    public record Resolution(String toolName, ToolTier tier, String source, String mapVersion) {}

    private ToolTierMap(int schemaVersion, String mapVersion,
                        Map<String, ToolTier> builtin,
                        Map<String, Map<String, ToolTier>> servers) {
        this.schemaVersion = schemaVersion;
        this.mapVersion = mapVersion;
        this.builtin = Map.copyOf(builtin);
        this.servers = Map.copyOf(servers);
    }

    /**
     * The map that ships with this build.
     *
     * @return the parsed shipped map — the same instance every time
     */
    public static ToolTierMap shipped() {
        return SHIPPED;
    }

    /**
     * Parses a map from JSON text. Visible for tests, which need a map whose
     * content they chose rather than the shipped one.
     *
     * @param json the map document
     * @return the parsed map
     * @throws IllegalArgumentException when the document is not a readable tier map
     */
    public static ToolTierMap parse(String json) {
        JsonNode root;
        try {
            root = JSON.readTree(json);
        } catch (IOException notJson) {
            throw new IllegalArgumentException("tier map is not JSON: " + notJson.getMessage());
        }
        if (!root.isObject()) {
            throw new IllegalArgumentException("tier map must be a JSON object");
        }
        int schema = root.path("schemaVersion").asInt(0);
        if (schema != 1) {
            throw new IllegalArgumentException("tier map schemaVersion must be 1, was " + schema);
        }
        String version = root.path("mapVersion").asText("");
        if (version.isBlank()) {
            throw new IllegalArgumentException("tier map carries no mapVersion");
        }
        Map<String, ToolTier> builtin = readSection(root.path("builtin"), "builtin");
        Map<String, Map<String, ToolTier>> servers = new LinkedHashMap<>();
        JsonNode serverBlock = root.path("servers");
        if (serverBlock.isObject()) {
            serverBlock.properties().forEach(entry -> {
                if (COMMENT_KEY.equals(entry.getKey())) {
                    return;
                }
                servers.put(entry.getKey(),
                        readSection(entry.getValue(), "servers." + entry.getKey()));
            });
        }
        return new ToolTierMap(schema, version, builtin, servers);
    }

    /** One section, tool name to tier; a bad tier word fails the load rather than
     *  becoming a silent widening at some later gate decision. */
    private static Map<String, ToolTier> readSection(JsonNode section, String where) {
        Map<String, ToolTier> tiers = new LinkedHashMap<>();
        if (!section.isObject()) {
            return tiers;
        }
        section.properties().forEach(entry -> {
            if (COMMENT_KEY.equals(entry.getKey())) {
                return;
            }
            ToolTier tier = ToolTier.parse(entry.getValue().asText(""));
            if (tier == null) {
                throw new IllegalArgumentException("tier map " + where + "." + entry.getKey()
                        + " names no tier: \"" + entry.getValue().asText("") + "\"");
            }
            tiers.put(entry.getKey(), tier);
        });
        return tiers;
    }

    /** Reads the shipped resource out of the jar. A map that will not load is a
     *  build defect, not a runtime condition to degrade around: without it the
     *  gate has no tiers and every entry would have to be re-decided. */
    private static ToolTierMap load() {
        try (InputStream stream = ToolTierMap.class.getResourceAsStream(RESOURCE)) {
            if (stream == null) {
                throw new IllegalStateException("the shipped tier map " + RESOURCE + " is missing");
            }
            return parse(new String(stream.readAllBytes(), StandardCharsets.UTF_8));
        } catch (IOException unreadable) {
            throw new IllegalStateException("the shipped tier map is unreadable", unreadable);
        }
    }

    /** @return the map document's schema version */
    public int schemaVersion() {
        return schemaVersion;
    }

    /** @return the map's own version, stamped onto every audit line */
    public String mapVersion() {
        return mapVersion;
    }

    /**
     * The tier of one tool, by the map alone.
     *
     * @param toolName the tool as the model addresses it — {@code mcp__<server>__<tool>} for MCP
     * @return the resolution; {@link ToolTier#EVAL_EXECUTE} with source "unmapped" when nothing names it
     */
    public Resolution resolve(String toolName) {
        if (toolName == null || toolName.isBlank()) {
            return new Resolution(toolName, ToolTier.EVAL_EXECUTE, "unmapped", mapVersion);
        }
        if (toolName.startsWith(MCP_PREFIX)) {
            int split = toolName.indexOf(MCP_SEPARATOR, MCP_PREFIX.length());
            if (split > MCP_PREFIX.length()) {
                String server = toolName.substring(MCP_PREFIX.length(), split);
                String remote = toolName.substring(split + MCP_SEPARATOR.length());
                ToolTier tier = servers.getOrDefault(server, Map.of()).get(remote);
                return tier == null
                        ? new Resolution(toolName, ToolTier.EVAL_EXECUTE, "unmapped", mapVersion)
                        : new Resolution(toolName, tier, "server:" + server, mapVersion);
            }
            return new Resolution(toolName, ToolTier.EVAL_EXECUTE, "unmapped", mapVersion);
        }
        ToolTier tier = builtin.get(toolName);
        return tier == null
                ? new Resolution(toolName, ToolTier.EVAL_EXECUTE, "unmapped", mapVersion)
                : new Resolution(toolName, tier, "builtin", mapVersion);
    }

    /**
     * The tier of one tool with a hint from outside the product folded in — the
     * seam a later MCP revision's annotations would arrive through.
     *
     * <p>The fold is {@link ToolTier#widest}, deliberately: a hint may RAISE a
     * tool above its mapped tier and can never lower it, and it never creates a
     * tier for a tool the map omits (the omission already resolves to the widest
     * tier there is, so the widest-wins rule makes that automatic). Nothing feeds
     * this today — the pinned revision has no annotations to feed it — and moving
     * the pin is its own card. It lives here so that when the pin moves there is
     * one place to wire it, already tested in the direction that matters.
     *
     * @param toolName the tool as the model addresses it
     * @param wireHint a tier claimed from outside the map, or null for no claim
     * @return the resolution, at the wider of map and hint
     */
    public Resolution resolve(String toolName, ToolTier wireHint) {
        Resolution mapped = resolve(toolName);
        ToolTier folded = mapped.tier().widest(wireHint);
        return folded == mapped.tier()
                ? mapped
                : new Resolution(mapped.toolName(), folded, mapped.source() + "+hint", mapVersion);
    }
}
