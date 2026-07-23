package dev.spectroscope.server;

import dev.spectroscope.core.config.SpectroConfig;
import dev.spectroscope.core.trace.OtlpSink;

import java.util.LinkedHashMap;
import java.util.Map;
import java.util.function.Supplier;

import org.springframework.web.bind.annotation.CrossOrigin;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RestController;

/**
 * The doctor's OTLP check: is the configured exporter endpoint reachable and
 * does it accept our auth? Probes with an EMPTY resourceSpans batch — a valid
 * OTLP request that ingests nothing — so a green light means "a real run's
 * spans will land". Never echoes the auth value.
 */
@CrossOrigin
@RestController
public class OtlpProbeController {

    /** Seam: resolve the config (real: the server's base layers). */
    private final Supplier<SpectroConfig> configLoader;
    /** Seam: run one probe against (endpoint, basicAuth) — null = real HTTP. */
    private final OtlpSink.Prober prober;

    /** Spring wiring — real config, real HTTP probe. */
    public OtlpProbeController() {
        this(() -> SpectroConfig.load(SpectroConfig.Overrides.none()), null);
    }

    /**
     * Seam constructor for tests.
     *
     * @param configLoader the config source
     * @param prober       the probe implementation (null = real HTTP)
     */
    OtlpProbeController(Supplier<SpectroConfig> configLoader, OtlpSink.Prober prober) {
        this.configLoader = configLoader;
        this.prober = prober != null ? prober : OtlpSink::probe;
    }

    /**
     * Probe the configured OTLP endpoint.
     *
     * @return {configured:false} when off; else {configured:true, endpoint,
     *         ok, message?} — message only on failure, auth never echoed
     */
    @GetMapping("/api/otlp/probe")
    public Map<String, Object> probe() {
        SpectroConfig config = configLoader.get();
        Map<String, Object> out = new LinkedHashMap<>();
        String endpoint = config.otlpEndpoint();
        if (endpoint == null || endpoint.isBlank()) {
            out.put("configured", false);
            return out;
        }
        out.put("configured", true);
        out.put("endpoint", endpoint);
        try {
            prober.probe(endpoint, config.otlpBasicAuth());
            out.put("ok", true);
        } catch (Exception failed) {
            out.put("ok", false);
            out.put("message", String.valueOf(failed.getMessage()));
        }
        return out;
    }
}
