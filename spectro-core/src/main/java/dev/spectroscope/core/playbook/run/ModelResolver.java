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

        /**
         * Provider, model, address and reason in one sentence (card 194
         * criterion 6). A probe without an address names the provider's
         * default address (card 584, criterion 7): that is what a provider
         * whose address is fixed in its SDK is dialled at.
         *
         * @return the sentence
         */
        public String sentence() {
            if ("private-step-on-cloud".equals(probe.reason())) {
                return ref.provider() + " " + ref.model() + " is a cloud " + (cloudModel(ref) ? "model" : "provider")
                        + " and this is a private step";
            }
            String where = probe.endpoint() == null ? "the default address of " + ref.provider() : probe.endpoint();
            if (probe.answers()) {
                return ref.provider() + " answers at " + where + " but does not list " + ref.model();
            }
            String why = probe.reason() != null ? probe.reason() : probe.state();
            return ref.provider() + " " + ref.model() + " does not answer at " + where + " (" + why + ")";
        }

        /**
         * Card 584: one word for why the model does not serve, for the start
         * sheet: {@code private-on-cloud}, {@code not-listed} when the provider
         * answers without the model, else the reason of the provider's last
         * check ({@code rejected-key}, {@code refused}, {@code timeout},
         * {@code http-<status>}, {@code bad-answer}, {@code no-key}), else its
         * state ({@code needs-key}, {@code needs-signin}, {@code needs-download},
         * {@code configured}, {@code unknown}).
         *
         * @return the reason word
         */
        public String code() {
            if ("private-step-on-cloud".equals(probe.reason())) {
                return "private-on-cloud";
            }
            if (probe.answers()) {
                return "not-listed";
            }
            return probe.reason() != null ? probe.reason() : probe.state();
        }
    }

    private ModelResolver() {
    }

    /**
     * Fix round (review D2): Ollama is a keyless local server, but it forwards
     * a model whose tag is {@code cloud} or ends in {@code -cloud} (for
     * example {@code minimax-m3:cloud}, {@code gpt-oss:120b-cloud}) to its
     * cloud. Such a model counts as cloud for a private step.
     *
     * @param ref a provider and model
     * @return true for an Ollama cloud model
     */
    public static boolean cloudModel(Playbook.ModelRef ref) {
        if (!"ollama".equals(ref.provider()) || ref.model() == null) {
            return false;
        }
        int colon = ref.model().lastIndexOf(':');
        String tag = colon < 0 ? "" : ref.model().substring(colon + 1);
        return "cloud".equals(tag) || tag.endsWith("-cloud");
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
            if (privateStep && ("cloud".equals(row.kind()) || cloudModel(ref))) {
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
