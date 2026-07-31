package dev.spectroscope.samples.otel;

import dev.spectroscope.Spectro;
import dev.spectroscope.Tools;
import dev.spectroscope.core.config.SpectroConfig;
import dev.spectroscope.core.events.RunEvent;
import dev.spectroscope.core.session.SessionStore;
import dev.spectroscope.core.trace.JsonlSink;
import dev.spectroscope.core.trace.OtlpSink;

import java.nio.file.Path;
import java.util.Optional;

/**
 * The shipped OTLP exporter in an embedded run. {@link OtlpSink} folds a
 * session's events into OTel GenAI spans and posts them to any OTLP/HTTP
 * traces endpoint (Jaeger, Langfuse, Phoenix, …). The CLI and server attach
 * it automatically when {@code SPECTRO_OTLP_ENDPOINT} is set; an embedded
 * caller tees the stream into it by hand, next to the JSONL sink.
 *
 * <pre>
 * SPECTRO_OTLP_ENDPOINT=http://localhost:4318/v1/traces gradle run
 * </pre>
 */
public final class OtelExport {

    public static void main(String[] args) throws InterruptedException {
        SpectroConfig config = SpectroConfig.load(SpectroConfig.Overrides.none());

        var store = new SessionStore();
        var jsonl = new JsonlSink(store);
        Optional<OtlpSink> otlp = OtlpSink.fromConfig(config, store.id());
        System.out.println(otlp.isPresent()
                ? "Exporting spans to " + config.otlpEndpoint()
                : "SPECTRO_OTLP_ENDPOINT is not set — recording JSONL only "
                        + "(the README has a one-line Jaeger to point it at).");

        var agent = Spectro.agent()
                .model(new ScriptedProvider())
                .tools(Tools.writeFile(), Tools.readFile())
                .workspace(Path.of(System.getProperty("java.io.tmpdir"), "spectro-otel-sample"));

        for (RunEvent event : agent.run("Write hello.txt with a short greeting")) {
            jsonl.onEvent(event);                       // durability first: the JSONL is the anchor
            otlp.ifPresent(sink -> sink.onEvent(event)); // the export is additive
            System.out.println(event);
        }

        System.out.println();
        System.out.println("Session " + store.id() + " recorded at " + store.file());
        if (otlp.isPresent()) {
            // The sink posts at the session's idle point, on a background thread —
            // give it a moment before the JVM exits.
            Thread.sleep(2000);
            System.out.println("Look for service \"spectroscope\" in your tracing UI.");
        }
    }
}
