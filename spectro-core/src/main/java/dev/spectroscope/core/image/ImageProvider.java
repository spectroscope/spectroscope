package dev.spectroscope.core.image;

/**
 * The image-side counterpart of {@link dev.spectroscope.core.provider.LlmProvider} — the same
 * port idea for a different capability: a narrow, blocking contract in front of a
 * cloud image API, so the {@link GenerateImageTool} never touches a concrete SDK.
 * Two implementations exist: {@link GeminiImageProvider} and
 * {@link OpenAiImageProvider}, plugged in without changing the tool.
 */
public interface ImageProvider {

    /**
     * Generates one image for the given prompt. Blocking, like everything in the core.
     *
     * @param prompt textual description of the desired image
     * @return the raw bytes and their media type, ready for the {@link ImageStore}
     * @throws RuntimeException with a short readable message on API errors (non-2xx
     *     status, or a response that carries no image)
     */
    Generated generate(String prompt);

    /** Stable provider name as it appears in events and the UI: {@code "gemini"} or {@code "openai"}. */
    String providerName();

    /** The model this provider instance was constructed with. */
    String model();

    /**
     * Raw image bytes plus their media type — ready for the content-addressed {@link ImageStore}.
     *
     * @param bytes     the decoded image payload
     * @param mediaType MIME type of the bytes, e.g. {@code image/png}
     */
    record Generated(byte[] bytes, String mediaType) {}
}
