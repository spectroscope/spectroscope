package dev.spectroscope.core.local;

import com.sun.net.httpserver.HttpServer;
import dev.spectroscope.core.provider.LlmProvider;
import dev.spectroscope.core.provider.OpenAiCompatProvider;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Duration;
import java.util.Optional;

import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertInstanceOf;
import static org.junit.jupiter.api.Assertions.assertTrue;

/** LocalProviderFactory turns a running local runtime into the OpenAI-compatible
 *  provider that drives it — the whole point of spectro-local: the bundled model
 *  reached through the same wire as every other local server. */
class LocalProviderFactoryTest {

    private LocalRuntime.Launcher stub() {
        return (model, port, __key) -> {
            HttpServer s = HttpServer.create(new InetSocketAddress("127.0.0.1", port), 0);
            s.createContext("/v1/models", ex -> {
                byte[] b = "{\"data\":[{\"id\":\"vibethinker-3b\"}]}".getBytes(StandardCharsets.UTF_8);
                ex.sendResponseHeaders(200, b.length);
                ex.getResponseBody().write(b);
                ex.close();
            });
            s.start();
            return (AutoCloseable) () -> s.stop(0);
        };
    }

    @Test
    void aHealthyRuntimeYieldsAnOpenAiCompatProvider(@TempDir Path dir) throws Exception {
        Path model = Files.writeString(dir.resolve("m.gguf"), "gguf");
        LocalRuntime rt = new LocalRuntime(stub(), "vibethinker-3b");
        Optional<LlmProvider> provider = LocalProviderFactory.build(rt, model);
        assertTrue(provider.isPresent(), "a healthy runtime yields a provider");
        assertInstanceOf(OpenAiCompatProvider.class, provider.get(),
                "spectro-local speaks the OpenAI-compatible wire, like every local server");
        rt.shutdown();
    }

    @Test
    void anUnhealthyRuntimeYieldsNoProvider(@TempDir Path dir) throws Exception {
        Path model = Files.writeString(dir.resolve("m.gguf"), "gguf");
        LocalRuntime dead = new LocalRuntime(
                (m, port, key) -> (AutoCloseable) () -> {}, "vibethinker-3b", Duration.ofMillis(600));
        assertFalse(LocalProviderFactory.build(dead, model).isPresent(),
                "no runtime -> no provider, a readable-error path for the caller");
    }
}
