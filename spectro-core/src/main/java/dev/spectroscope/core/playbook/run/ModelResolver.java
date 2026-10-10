package dev.spectroscope.core.playbook.run;

import dev.spectroscope.core.playbook.Playbook;

import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.function.Function;

/** Picks the model a step runs on: private takes the primary or nothing, cheap walks the fallbacks. */
public final class ModelResolver {

    /** The outcome of one resolution: a model that serves, or the first that did not. */
    public sealed interface Resolution permits Resolved, Unavailable {
    }

    /**
     * @param ref    the model that serves
     * @param probe  its registry row
     * @param walked the models tried before it, in order
     */
    public record Resolved(Playbook.ModelRef ref, Probe probe, List<Playbook.ModelRef> walked) implements Resolution {
    }

    /**
     * @param ref    the first model that did not serve
     * @param probe  its registry row
     * @param walked every model tried
     */
    public record Unavailable(Playbook.ModelRef ref, Probe probe, List<Playbook.ModelRef> walked) implements Resolution {

        /** @return provider, model, address and reason in one sentence (card 194 criterion 6) */
        public String sentence() {
            if ("private-step-on-cloud".equals(probe.reason())) {
                return ref.provider() + " " + ref.model() + " is a cloud provider and this is a private step";
            }
            String where = probe.endpoint() == null ? "no address" : probe.endpoint();
            if (probe.answers()) {
                return ref.provider() + " answers at " + where + " but does not list " + ref.model();
            }
            String why = probe.reason() != null ? probe.reason() : probe.state();
            return ref.provider() + " " + ref.model() + " does not answer at " + where + " (" + why + ")";
        }
    }

    private ModelResolver() {
    }

    /**
     * @param choice  the step's model choice
     * @param privacy private or cheap
     * @param probe   the registry check per provider name
     * @return the model that serves, or the first that did not
     */
    public static Resolution resolve(Playbook.ModelChoice choice, String privacy, Function<String, Probe> probe) {
        boolean privateStep = "private".equals(privacy);
        List<Playbook.ModelRef> candidates = new ArrayList<>();
        candidates.add(choice.primary());
        if (!privateStep) {
            candidates.addAll(choice.fallbacks());
        }
        Map<String, Probe> asked = new HashMap<>();
        List<Playbook.ModelRef> walked = new ArrayList<>();
        Unavailable first = null;
        for (Playbook.ModelRef ref : candidates) {
            Probe row = asked.computeIfAbsent(ref.provider(), probe);
            if (privateStep && "cloud".equals(row.kind())) {
                Probe refused = new Probe(row.provider(), row.kind(), "refused", row.endpoint(),
                        "private-step-on-cloud", row.models(), row.live(), row.checkedAt());
                return new Unavailable(ref, refused, List.of(ref));
            }
            if (row.serves(ref.model())) {
                return new Resolved(ref, row, List.copyOf(walked));
            }
            if (first == null) {
                first = new Unavailable(ref, row, List.of());
            }
            walked.add(ref);
        }
        return new Unavailable(first.ref(), first.probe(), List.copyOf(walked));
    }
}
