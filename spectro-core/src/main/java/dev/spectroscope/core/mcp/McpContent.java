package dev.spectroscope.core.mcp;

/**
 * One block of an MCP {@code tools/call} reply, in the shape spectroscope keeps
 * it. MCP 2024-11-05 defines text, image, audio and resource blocks; the two
 * modeled here are the two the harness can carry to a model today. Everything
 * else stays unmodeled on purpose — {@link McpCallResult} then falls back to the
 * raw result JSON exactly as it always has, rather than quietly dropping content
 * nobody has taught it to read.
 *
 * <p>The image block holds the payload <b>still encoded</b>. That is deliberate:
 * the size gate in {@link McpTool} decides on the encoded length, so an untrusted
 * server never gets a decoded copy of an arbitrarily large payload allocated for it.
 */
public sealed interface McpContent {

    /**
     * A {@code text} block.
     *
     * @param text the block's text, never null (a missing field reads as empty)
     */
    record Text(String text) implements McpContent {}

    /**
     * An {@code image} block, undecoded.
     *
     * @param mediaType the block's {@code mimeType}, e.g. {@code image/png}
     * @param dataBase64 the block's {@code data}, base64 with no {@code data:} prefix
     */
    record Image(String mediaType, String dataBase64) implements McpContent {}
}
