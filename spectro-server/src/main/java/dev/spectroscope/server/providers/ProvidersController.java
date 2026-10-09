package dev.spectroscope.server.providers;

import dev.spectroscope.core.config.SpectroConfig;
import dev.spectroscope.server.web.LocalOrigin;
import jakarta.servlet.http.HttpServletRequest;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

import java.util.LinkedHashMap;
import java.util.Map;

/**
 * The provider registry on the wire. {@code GET /api/providers} is presence
 * plus whatever the last check stored and sends nothing to any provider.
 * {@code POST /api/providers/check} sends requests on the operator's keys and
 * addresses, so it wears the same loopback and Origin fence as the key save
 * route: a foreign page gets 404.
 */
@RestController
public class ProvidersController {

    private final ProviderRegistry registry;

    /** The controller on the process wide registry. */
    public ProvidersController() {
        this(ProviderRegistry.shared());
    }

    ProvidersController(ProviderRegistry registry) {
        this.registry = registry;
    }

    /**
     * {@code GET /api/providers}: one row per known provider. Sends no request.
     *
     * @return {@code {providers: [row...]}}
     */
    @GetMapping("/api/providers")
    public Map<String, Object> list() {
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("providers", registry.rows(SpectroConfig.load(SpectroConfig.Overrides.none())));
        return out;
    }

    /**
     * {@code POST /api/providers/check}: runs a bounded check and returns the rows.
     *
     * @param provider a provider id, {@code all} or {@code local}
     * @param request  the servlet request, for the fences
     * @return the rows after the check; 404 for a non local caller; 400 for an unknown id
     */
    @PostMapping("/api/providers/check")
    public ResponseEntity<Map<String, Object>> check(
            @RequestParam(name = "provider", defaultValue = "all") String provider,
            HttpServletRequest request) {
        if (!LocalOrigin.isLocalOrigin(request) || !LocalOrigin.originIsLoopbackOrAbsent(request)) {
            return ResponseEntity.status(404).build();
        }
        SpectroConfig c = SpectroConfig.load(SpectroConfig.Overrides.none());
        Map<String, Object> out = new LinkedHashMap<>();
        switch (provider) {
            case "all" -> out.put("providers", registry.checkAll(c, row -> true));
            case "local" -> out.put("providers", registry.checkAll(c, row -> "local".equals(row.kind())));
            default -> {
                if (!SpectroConfig.knownProviders().contains(provider)) {
                    return ResponseEntity.badRequest().build();
                }
                registry.check(provider, c);
                out.put("providers", registry.rows(c));
            }
        }
        return ResponseEntity.ok(out);
    }
}
