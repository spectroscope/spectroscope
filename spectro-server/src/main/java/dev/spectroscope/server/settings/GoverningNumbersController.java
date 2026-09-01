package dev.spectroscope.server.settings;

import dev.spectroscope.core.config.governing.GoverningNumber;
import dev.spectroscope.core.config.governing.GoverningNumbers;

import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RestController;

import java.util.List;

/**
 * The numbers that govern a run, read out for the settings room — card 357.
 *
 * <p>The answer is the generated registry and nothing else: the list, the
 * values, the units, the kinds and the explanations all come from
 * {@code spectro-core}'s source tree by way of
 * {@code GoverningNumbersDriftTest}, so this controller has no table of its
 * own to keep in step. That is the point of the card. A settings page that
 * typed 76 constants in TypeScript would rot before the next release, and this
 * house has found that exact defect — a hand-list guarded by a test that types
 * the same hand-list — three times in one card.</p>
 *
 * <p>No {@code @CrossOrigin}, matching the settings controller beside it: the
 * production UI is served from this same jar and the dev server proxies
 * {@code /api}, so a wildcard policy would only widen who may read this
 * installation's limits. The answer grants nothing and takes no parameter, but
 * it does fingerprint a build.</p>
 */
@RestController
public class GoverningNumbersController {

    /** Stateless: the registry is a static resource of the core jar. */
    public GoverningNumbersController() {
    }

    /**
     * Every classified numeric constant this build carries — governing ones
     * and the aliases and plumbing that say, in their own javadoc, why they
     * are not.
     *
     * @return the registry, in the order it is generated in
     */
    @GetMapping("/api/governing-numbers")
    public List<GoverningNumber> governingNumbers() {
        return GoverningNumbers.all();
    }
}
