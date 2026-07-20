package dev.spectroscope.core.provider;

/**
 * Constructor options for the {@link OllamaProvider} (BUILD-PLAN.md).
 *
 * @param baseUrl the Ollama server root, e.g. http://localhost:11434 (a trailing slash is tolerated)
 * @param model   the model name requests are sent to, e.g. "qwen3"
 */
public record OllamaOptions(String baseUrl, String model) {}
