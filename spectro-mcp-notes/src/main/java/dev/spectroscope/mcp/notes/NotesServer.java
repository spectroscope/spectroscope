package dev.spectroscope.mcp.notes;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ArrayNode;
import com.fasterxml.jackson.databind.node.ObjectNode;

import java.io.BufferedReader;
import java.io.IOException;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.io.PrintStream;
import java.nio.charset.StandardCharsets;
import java.nio.file.Path;
import java.util.List;

/**
 * A tiny MCP server speaking <b>stdio JSON-RPC 2.0</b>: it reads one JSON request
 * per line from stdin, writes one JSON response per line to stdout, and logs to
 * stderr only (stdout is the protocol channel — anything else on it corrupts the
 * stream). It implements exactly what an MCP client needs: {@code initialize},
 * {@code tools/list}, and {@code tools/call} dispatching to {@link Ranker#search}
 * and {@link NotesStore#add}.
 *
 * <p>No MCP SDK is used — plain Jackson plus {@code System.in}/{@code System.out}.
 * The request handler is exposed as {@link #handle(String)} so tests can drive it
 * in-JVM over piped streams without spawning a process.
 */
public final class NotesServer {

    private static final ObjectMapper JSON = new ObjectMapper();
    private static final String PROTOCOL_VERSION = "2024-11-05";
    private static final String SERVER_NAME = "spectro-mcp-notes";
    private static final String SERVER_VERSION = "0.0.1";

    private final NotesStore store;

    /**
     * Creates the server on top of a notes directory.
     *
     * @param store the notes "database" both tools operate on — {@code search_notes}
     *              reads it, {@code add_note} writes it
     */
    public NotesServer(NotesStore store) {
        this.store = store;
    }

    // ---- entry point -------------------------------------------------------

    /**
     * Boots the server and blocks in the stdio loop until stdin closes. The notes
     * directory comes from the first CLI argument ({@code ~} expanded) or defaults
     * to {@code ~/.spectro/notes}; the choice is logged to stderr, never stdout.
     *
     * @param args optional — a non-blank {@code args[0]} overrides the notes directory
     */
    public static void main(String[] args) throws IOException {
        Path dir = args.length > 0 && !args[0].isBlank()
                ? Path.of(expandHome(args[0]))
                : Path.of(System.getProperty("user.home"), ".spectro", "notes");
        System.err.println("[spectro-mcp-notes] serving notes from " + dir);
        new NotesServer(new NotesStore(dir)).serve(System.in, System.out);
    }

    /**
     * The blocking stdio loop: read a line, handle it, write the response line.
     * A request that produces no response (a notification, e.g. no {@code id})
     * is answered with {@code null} from {@link #handle(String)} and skipped.
     *
     * @param in  the request channel — one JSON-RPC message per line, UTF-8
     * @param out the response channel; this is the protocol stream, nothing else
     *            may ever write to it
     */
    public void serve(InputStream in, OutputStream out) throws IOException {
        BufferedReader reader = new BufferedReader(new InputStreamReader(in, StandardCharsets.UTF_8));
        PrintStream writer = new PrintStream(out, true, StandardCharsets.UTF_8);
        String line;
        while ((line = reader.readLine()) != null) {
            if (line.isBlank()) {
                continue;
            }
            String response = handle(line);
            if (response != null) {
                writer.println(response);
            }
        }
    }

    // ---- request handling (testable in-JVM) --------------------------------

    /**
     * Handles a single JSON-RPC request line and returns the response line, or
     * {@code null} when no response is due (a notification, or unparseable input
     * with no id to answer). Never throws — a bad request becomes a JSON-RPC
     * error object.
     *
     * @param requestLine one raw JSON-RPC message, exactly as read from stdin
     * @return the serialized response line, or {@code null} when nothing must be written
     */
    public String handle(String requestLine) {
        JsonNode req;
        try {
            req = JSON.readTree(requestLine);
        } catch (IOException e) {
            // Parse error, and no id is recoverable → nothing to answer.
            return null;
        }

        JsonNode idNode = req.get("id");
        String method = req.path("method").asText("");
        boolean isNotification = idNode == null || idNode.isNull();

        try {
            JsonNode result = dispatch(method, req.path("params"));
            if (result == null) {
                // Unknown method.
                return isNotification ? null : error(idNode, -32601, "Method not found: " + method);
            }
            return isNotification ? null : success(idNode, result);
        } catch (RuntimeException e) {
            return isNotification ? null : error(idNode, -32603, "Internal error: " + e.getMessage());
        }
    }

    /**
     * Returns the result node for a method, or {@code null} if the method is unknown.
     *
     * @param method the JSON-RPC method name from the request
     * @param params the request's params node — a missing node reads as empty
     */
    private JsonNode dispatch(String method, JsonNode params) {
        return switch (method) {
            case "initialize" -> initialize();
            case "tools/list" -> toolsList();
            case "tools/call" -> toolsCall(params);
            case "notifications/initialized", "initialized" -> JSON.createObjectNode();
            default -> null;
        };
    }

    /**
     * The {@code initialize} result: protocol version, a tools-only capability
     * marker, and the server's name and version.
     */
    private JsonNode initialize() {
        ObjectNode result = JSON.createObjectNode();
        result.put("protocolVersion", PROTOCOL_VERSION);
        ObjectNode caps = result.putObject("capabilities");
        caps.putObject("tools");
        ObjectNode serverInfo = result.putObject("serverInfo");
        serverInfo.put("name", SERVER_NAME);
        serverInfo.put("version", SERVER_VERSION);
        return result;
    }

    /** The {@code tools/list} result: the descriptors of search_notes and add_note. */
    private JsonNode toolsList() {
        ObjectNode result = JSON.createObjectNode();
        ArrayNode tools = result.putArray("tools");
        tools.add(searchToolDescriptor());
        tools.add(addToolDescriptor());
        return result;
    }

    /**
     * The search_notes descriptor: name, description, and a JSON schema with a
     * required {@code query} plus an optional integer {@code limit}.
     */
    private ObjectNode searchToolDescriptor() {
        ObjectNode tool = JSON.createObjectNode();
        tool.put("name", "search_notes");
        tool.put("description",
                "Full-text search over the notes database. Returns ranked snippets, "
                        + "each with its source note file.");
        ObjectNode schema = tool.putObject("inputSchema");
        schema.put("type", "object");
        ObjectNode props = schema.putObject("properties");
        ObjectNode query = props.putObject("query");
        query.put("type", "string");
        query.put("description", "The search query; multiple words are matched independently.");
        ObjectNode limit = props.putObject("limit");
        limit.put("type", "integer");
        limit.put("description", "Maximum number of results to return (default 5).");
        schema.putArray("required").add("query");
        return tool;
    }

    /** The add_note descriptor: a JSON schema requiring a single {@code text} string. */
    private ObjectNode addToolDescriptor() {
        ObjectNode tool = JSON.createObjectNode();
        tool.put("name", "add_note");
        tool.put("description", "Add a new note to the notes database.");
        ObjectNode schema = tool.putObject("inputSchema");
        schema.put("type", "object");
        ObjectNode props = schema.putObject("properties");
        ObjectNode text = props.putObject("text");
        text.put("type", "string");
        text.put("description", "The note text to store.");
        schema.putArray("required").add("text");
        return tool;
    }

    /**
     * Dispatches a {@code tools/call} to the named tool — an unknown name answers
     * a flagged tool error, not a JSON-RPC error (the call itself was well-formed).
     *
     * @param params the call params carrying {@code name} and {@code arguments}
     */
    private JsonNode toolsCall(JsonNode params) {
        String name = params.path("name").asText("");
        JsonNode arguments = params.path("arguments");
        return switch (name) {
            case "search_notes" -> callSearch(arguments);
            case "add_note" -> callAdd(arguments);
            default -> toolError("Unknown tool: " + name);
        };
    }

    /**
     * Runs search_notes: ranks every stored note against the query and formats
     * the hits as one text block, one {@code [file] snippet} line each. A missing
     * or non-positive limit falls back to 5.
     *
     * @param arguments the tool arguments — {@code query} (required) and {@code limit}
     */
    private JsonNode callSearch(JsonNode arguments) {
        String query = arguments.path("query").asText("");
        int limit = arguments.has("limit") && arguments.get("limit").isInt()
                ? arguments.get("limit").asInt()
                : 5;
        if (limit <= 0) {
            limit = 5;
        }
        List<Ranker.Hit> hits = Ranker.search(store.list(), query, limit);
        StringBuilder body = new StringBuilder();
        if (hits.isEmpty()) {
            body.append("No notes matched \"").append(query).append("\".");
        } else {
            body.append("Found ").append(hits.size()).append(" note(s) for \"")
                    .append(query).append("\":\n");
            for (Ranker.Hit hit : hits) {
                body.append("- [").append(hit.file()).append("] ")
                        .append(hit.snippet()).append('\n');
            }
        }
        return textContent(body.toString().strip());
    }

    /**
     * Runs add_note: stores the text as a new note file and reports the created
     * file name; blank text is refused as a flagged tool error.
     *
     * @param arguments the tool arguments — a non-empty {@code text}
     */
    private JsonNode callAdd(JsonNode arguments) {
        String text = arguments.path("text").asText("");
        if (text.isBlank()) {
            return toolError("add_note requires non-empty 'text'.");
        }
        String file = store.add(text);
        return textContent("Added note " + file + ".");
    }

    // ---- MCP result / JSON-RPC envelope helpers ----------------------------

    /**
     * An MCP tool result: {@code {"content":[{"type":"text","text":...}]}}.
     *
     * @param text the human-readable body the calling model receives
     */
    private ObjectNode textContent(String text) {
        ObjectNode result = JSON.createObjectNode();
        ArrayNode content = result.putArray("content");
        ObjectNode item = content.addObject();
        item.put("type", "text");
        item.put("text", text);
        return result;
    }

    /**
     * An MCP tool result flagged as an error (still a valid JSON-RPC result).
     *
     * @param message the readable failure text for the model
     */
    private ObjectNode toolError(String message) {
        ObjectNode result = textContent(message);
        result.put("isError", true);
        return result;
    }

    /**
     * Wraps a result in the JSON-RPC 2.0 success envelope, echoing the request id.
     *
     * @param id the request id to echo back
     * @param result the method result to embed
     * @return the serialized response line
     */
    private String success(JsonNode id, JsonNode result) {
        ObjectNode response = JSON.createObjectNode();
        response.put("jsonrpc", "2.0");
        response.set("id", id);
        response.set("result", result);
        return response.toString();
    }

    /**
     * Builds the JSON-RPC 2.0 error envelope.
     *
     * @param id the request id to echo; {@code null} becomes JSON null
     * @param code the JSON-RPC error code (e.g. -32601 method not found)
     * @param message the human-readable error text
     * @return the serialized response line
     */
    private String error(JsonNode id, int code, String message) {
        ObjectNode response = JSON.createObjectNode();
        response.put("jsonrpc", "2.0");
        response.set("id", id == null ? JSON.nullNode() : id);
        ObjectNode err = response.putObject("error");
        err.put("code", code);
        err.put("message", message);
        return response.toString();
    }

    /**
     * Expands a leading {@code ~} or {@code ~/} to the user's home directory —
     * launcher configs pass paths shell-style, but Java resolves no tilde.
     *
     * @param path the possibly tilde-prefixed path from the CLI argument
     * @return the expanded path, or the input unchanged when no tilde leads it
     */
    private static String expandHome(String path) {
        if (path.equals("~")) {
            return System.getProperty("user.home");
        }
        if (path.startsWith("~/")) {
            return System.getProperty("user.home") + path.substring(1);
        }
        return path;
    }
}
