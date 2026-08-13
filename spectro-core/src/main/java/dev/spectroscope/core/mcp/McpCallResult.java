package dev.spectroscope.core.mcp;

import com.fasterxml.jackson.databind.JsonNode;

import java.util.ArrayList;
import java.util.List;

/**
 * What one {@code tools/call} came back with: its content blocks, in the order
 * the server sent them. This is the <b>single</b> place the MCP reply shape is
 * read — both transports (stdio and HTTP/SSE) hand their raw {@code result} node
 * to {@link #fromToolsCall} instead of each keeping a private copy of the
 * mapping, which is how the two drifted apart before card 198.
 *
 * <p>{@link #text()} reproduces, byte for byte, the flattening the transports did
 * on their own: text blocks joined by newlines, and the raw result JSON when a
 * reply carries nothing this harness understands. Nothing about a text-only reply
 * changed when images arrived.
 *
 * @param blocks the reply's content blocks in server order, never empty
 */
public record McpCallResult(List<McpContent> blocks) {

    /** Defensive copy — a result is passed around and must not be edited under a caller. */
    public McpCallResult {
        blocks = List.copyOf(blocks);
    }

    /**
     * A result that is nothing but this text — the shape every error path uses.
     *
     * @param text the whole model-facing output
     * @return a single-block result
     */
    public static McpCallResult ofText(String text) {
        return new McpCallResult(List.of(new McpContent.Text(text)));
    }

    /**
     * Reads the {@code result} member of a {@code tools/call} response.
     *
     * <p>Text and image blocks are kept in order. Any other block type is left
     * unmodeled, and if the reply carried nothing else — no text, no image — the
     * whole raw result JSON becomes the single text block, which is what both
     * transports have always done with a shape they did not recognize.
     *
     * @param result the JSON-RPC {@code result} member of a {@code tools/call}
     * @return the parsed blocks, or the raw JSON as one text block
     */
    public static McpCallResult fromToolsCall(JsonNode result) {
        List<McpContent> parsed = new ArrayList<>();
        JsonNode content = result.path("content");
        if (content.isArray()) {
            for (JsonNode block : content) {
                switch (block.path("type").asText()) {
                    case "text" -> parsed.add(new McpContent.Text(block.path("text").asText()));
                    case "image" -> {
                        String data = block.path("data").asText("");
                        String mediaType = block.path("mimeType").asText("");
                        // An image block without payload or type cannot be carried
                        // anywhere; leave it unmodeled rather than invent a media type.
                        if (!data.isBlank() && !mediaType.isBlank()) {
                            parsed.add(new McpContent.Image(mediaType, data));
                        }
                    }
                    default -> { /* audio, resource, anything newer: unmodeled */ }
                }
            }
        }
        McpCallResult candidate = new McpCallResult(parsed);
        boolean nothingUnderstood = candidate.text().isEmpty() && !candidate.hasImages();
        return nothingUnderstood ? ofText(result.toString()) : candidate;
    }

    /**
     * The text blocks joined by newlines — the flattening as it always was: a
     * separator only once something is in the buffer, so a leading empty block
     * adds no blank line.
     *
     * @return the joined text, empty when the reply carries no text block
     */
    public String text() {
        StringBuilder joined = new StringBuilder();
        for (McpContent block : blocks) {
            if (block instanceof McpContent.Text text) {
                if (joined.length() > 0) {
                    joined.append('\n');
                }
                joined.append(text.text());
            }
        }
        return joined.toString();
    }

    /** True when at least one block is an image — the only reason to leave the text path. */
    public boolean hasImages() {
        return blocks.stream().anyMatch(McpContent.Image.class::isInstance);
    }
}
