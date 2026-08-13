package dev.spectroscope.core.mcp;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import dev.spectroscope.core.tools.Tool;

/**
 * Adapts one remote MCP tool into an ordinary spectroscope {@link Tool}. The punchline
 * of this stage: an MCP server is just another <i>tool source</i>, so once
 * wrapped its calls flow as plain {@code tool_call}/{@code tool_result} events —
 * no new {@code RunEvent} type, no JSONL change.
 *
 * <p>The name follows this harness's own convention, {@code mcp__<server>__<tool>};
 * the description and input schema come straight from {@code tools/list}. Every
 * MCP tool is permission-gated: its inputs are model output and its effects are
 * external, so it is untrusted by the house rule.
 */
public final class McpTool implements Tool {

    private static final ObjectMapper JSON = new ObjectMapper();

    /**
     * The most one image in an MCP tool result may weigh, in bytes — the providers'
     * own per-image wire limit (see {@link dev.spectroscope.core.image.ImageDownscaler}),
     * which is the point beyond which an attach would be rejected anyway.
     *
     * <p>Unlike {@code view_image}, an oversized MCP image is <b>refused, not
     * downscaled</b>: the payload comes from a remote server over an untrusted
     * connection, so the size is decided on the ENCODED length before anything is
     * decoded — a hostile server must not be able to make the harness allocate a
     * decoded copy of an arbitrarily large payload.
     */
    public static final long MAX_IMAGE_BYTES =
            dev.spectroscope.core.image.ImageDownscaler.WIRE_IMAGE_LIMIT_BYTES;

    private final String serverName;
    private final McpClient client;
    private final McpToolDescriptor descriptor;
    private final String qualifiedName;
    private final dev.spectroscope.core.image.ImageStore imageStore;

    /**
     * Wraps one advertised remote tool; the qualified name is fixed here and never recomputed.
     * Images land in the store every face shares, {@code ~/.spectro/images}.
     *
     * @param serverName configured server name — the middle segment of the qualified name
     * @param client     connection every call goes through
     * @param descriptor the remote tool as advertised by {@code tools/list}
     */
    public McpTool(String serverName, McpClient client, McpToolDescriptor descriptor) {
        this(serverName, client, descriptor, dev.spectroscope.core.image.ImageStore.inUserHome());
    }

    /**
     * The variant that names the image store — tests point it at a temp directory.
     *
     * @param serverName configured server name — the middle segment of the qualified name
     * @param client     connection every call goes through
     * @param descriptor the remote tool as advertised by {@code tools/list}
     * @param imageStore where image bytes from a tool result are persisted
     */
    public McpTool(String serverName, McpClient client, McpToolDescriptor descriptor,
                   dev.spectroscope.core.image.ImageStore imageStore) {
        this.serverName = serverName;
        this.client = client;
        this.descriptor = descriptor;
        this.qualifiedName = "mcp__" + serverName + "__" + descriptor.name();
        this.imageStore = imageStore;
    }

    /** The configured server this tool belongs to. */
    public String serverName() {
        return serverName;
    }

    /** The unqualified tool name as the server knows it — what {@code tools/call} is sent. */
    public String remoteName() {
        return descriptor.name();
    }

    /** The harness-side name the model calls: {@code mcp__<server>__<tool>}. */
    @Override
    public String name() {
        return qualifiedName;
    }

    /** The server's own description, or an empty string when it sent none. */
    @Override
    public String description() {
        return descriptor.description() != null ? descriptor.description() : "";
    }

    /**
     * The remote tool's argument schema, <b>never null</b>. A {@code tools/list}
     * entry may omit {@code inputSchema} (or send a non-object), in which case the
     * descriptor's schema is null/scalar; we substitute an empty object schema
     * {@code {"type":"object"}} so a provider that reads {@code node.has("properties")}
     * (e.g. AnthropicProvider.toSchema) never NPEs on untrusted server output.
     */
    @Override
    public JsonNode inputSchema() {
        JsonNode schema = descriptor.inputSchema();
        if (schema == null || !schema.isObject()) {
            ObjectNode empty = JSON.createObjectNode();
            empty.put("type", "object");
            return empty;
        }
        return schema;
    }

    /** Always {@code true} — the inputs are model output and the effects are external. */
    @Override
    public boolean needsPermission() {
        return true;
    }

    /**
     * Runs the remote tool and turns its reply into what the model gets.
     *
     * <p>A reply without images is the string it always was — {@link McpClient#call}
     * already degrades every failure to an {@code ERROR: ...} text block, so there is
     * nothing to catch. A reply <b>with</b> images walks the blocks in server order:
     * text stays text, and every image is carried to the model over the same attach
     * path {@code view_image} uses, leaving a numbered one-line note where it stood.
     * The payload never enters the string — that is the whole point of card 198.
     *
     * @param input   JSON arguments from the model, passed through unmodified
     * @param context the attach sink for the images, the emit sink for their references
     * @return the remote tool's text, with a note per image, or an {@code ERROR: ...} string
     */
    @Override
    public String execute(JsonNode input, ToolContext context) {
        McpCallResult result = client.call(descriptor.name(), input);
        if (!result.hasImages()) {
            // Byte for byte what this tool returned before images were understood.
            return result.text();
        }
        StringBuilder narrated = new StringBuilder();
        int imageNumber = 0;
        for (McpContent block : result.blocks()) {
            String piece = switch (block) {
                case McpContent.Text text -> text.text();
                case McpContent.Image image -> carry(image, ++imageNumber, context);
            };
            if (narrated.length() > 0) {
                narrated.append('\n');
            }
            narrated.append(piece);
        }
        return narrated.toString();
    }

    /**
     * Carries one image block to the model: the size is decided on the ENCODED
     * payload, so an oversized image is refused before a decoded copy of it exists;
     * within the cap the bytes are stored content-addressed, announced as an
     * {@code image_generated} reference event, and attached for the model to see.
     *
     * <p>The event reuses the store-and-reference shape {@code generate_image}
     * established, with the fields that name a generation naming the MCP origin
     * instead: {@code provider} is {@code "mcp"}, {@code model} the configured
     * server, {@code prompt} the qualified tool name. Bytes never enter the event.
     *
     * @param image       the undecoded image block as the server sent it
     * @param imageNumber 1-based position among the images of this one reply
     * @param context     the run's attach and emit sinks
     * @return the one-line note that stands where the image stood
     */
    private String carry(McpContent.Image image, int imageNumber, ToolContext context) {
        long bytes = decodedLength(image.dataBase64());
        if (bytes > MAX_IMAGE_BYTES) {
            return "[image " + imageNumber + " not attached: " + bytes
                    + " bytes exceeds the " + MAX_IMAGE_BYTES + " byte cap for one MCP image]";
        }
        byte[] decoded;
        try {
            decoded = java.util.Base64.getDecoder().decode(image.dataBase64());
        } catch (IllegalArgumentException notBase64) {
            return "[image " + imageNumber + " not attached: the server's payload is not base64]";
        }
        try {
            dev.spectroscope.core.image.ImageStore.Ref ref =
                    imageStore.put(decoded, image.mediaType());
            context.emit().accept(new dev.spectroscope.core.events.RunEvent.ImageGenerated(
                    context.agentId(), context.callId(), qualifiedName, "mcp", serverName,
                    image.mediaType(), ref.blobPath(), ref.sha256(), System.currentTimeMillis()));
        } catch (RuntimeException notStored) {
            return "[image " + imageNumber + " not attached: it could not be stored: "
                    + notStored.getMessage() + "]";
        }
        context.attach().accept(
                new Tool.AttachedImage(image.mediaType(), image.dataBase64()));
        return "[image " + imageNumber + " attached (" + image.mediaType() + ", " + bytes
                + " bytes) — it is included with this result for you to see]";
    }

    /**
     * How many bytes a base64 payload decodes to, computed from the encoded length
     * alone — no decode, no allocation. This is what makes the cap a real defence
     * against a hostile server rather than a check that runs after the damage.
     *
     * @param base64 the encoded payload, padded or not
     * @return the decoded size in bytes
     */
    static long decodedLength(String base64) {
        int length = base64.length();
        int padding = 0;
        if (length > 0 && base64.charAt(length - 1) == '=') {
            padding++;
        }
        if (length > 1 && base64.charAt(length - 2) == '=') {
            padding++;
        }
        long whole = (long) (length / 4) * 3;
        // An unpadded tail of 2 characters carries 1 byte, of 3 characters 2 bytes.
        long tail = switch (length % 4) {
            case 2 -> 1;
            case 3 -> 2;
            default -> 0;
        };
        return whole + tail - padding;
    }
}
