package dev.spectroscope.core.playbook.run;

import com.fasterxml.jackson.databind.JsonNode;
import dev.spectroscope.core.config.governing.Governs;
import dev.spectroscope.core.playbook.Playbook;

import java.util.ArrayList;
import java.util.HashMap;
import java.util.Iterator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.TreeSet;
import java.util.function.Function;
import java.util.function.Predicate;

/**
 * Card 584: the models the owner picked in the start sheet, one per node that
 * runs on a model, for one run. They arrive with {@code start_playbook} from
 * the page and are untrusted input: {@link #read} accepts only an object of
 * node id to {@code {provider, model}} text, and {@link #refusal} accepts only
 * nodes of the pinned playbook that run on a model, providers the app knows,
 * and picks that serve on a fresh check of their provider, decided by
 * {@link ModelResolver} as the run decides it, so a private node never takes a
 * cloud provider or an Ollama cloud model ({@link ModelResolver#cloudModel}).
 * A pick is held in {@link PlaybookRunner.Setup#picks()} and
 * nowhere else; the playbook folder is never written.
 */
public final class ModelPicks {

    /** The most picks one start may carry: the page is untrusted input, and a playbook has far fewer steps and checks. */
    @Governs(kind = Governs.Kind.FIXED, unit = Governs.Unit.COUNT)
    public static final int MAX_PICKS = 256;
    /** The longest node id a pick may name: a bound on untrusted input, above any node id a playbook uses. */
    @Governs(kind = Governs.Kind.FIXED, unit = Governs.Unit.CHARACTERS)
    public static final int MAX_NODE_CHARS = 128;
    /** The longest model id a pick may name: a bound on untrusted input, above the model ids the providers list. */
    @Governs(kind = Governs.Kind.FIXED, unit = Governs.Unit.CHARACTERS)
    public static final int MAX_MODEL_CHARS = 200;
    /** The longest provider name a pick may name: a bound on untrusted input, above any registered provider name. */
    @Governs(kind = Governs.Kind.FIXED, unit = Governs.Unit.CHARACTERS)
    public static final int MAX_PROVIDER_CHARS = 64;

    /** The refusal for picks whose shape does not read. */
    public static final String UNREADABLE =
            "The model picks of this start do not read: each one is a step id with a provider and a model.";

    /**
     * One node that runs on a model: a step, or a decision whose check is a review.
     *
     * @param id      the node id
     * @param name    the node's name
     * @param kind    {@code step} or {@code review}
     * @param choice  the model choice the node names
     * @param privacy {@code private} or {@code cheap}; a review takes the privacy of what it reads
     */
    public record Node(String id, String name, String kind, String choice, String privacy) {
    }

    /**
     * The picks of a frame, or the refusal of their shape.
     *
     * @param picks   node id to provider and model; empty when refused or absent
     * @param refusal {@link #UNREADABLE}, or null when the shape reads
     */
    public record Read(Map<String, Playbook.ModelRef> picks, String refusal) {
    }

    private ModelPicks() {
    }

    /**
     * The nodes a pick may name.
     *
     * @param p the playbook
     * @return every node that runs on a model, in node order
     */
    public static List<Node> nodes(Playbook p) {
        List<Node> out = new ArrayList<>();
        for (Playbook.Node n : p.nodes()) {
            if (n instanceof Playbook.Step s) {
                out.add(new Node(s.id(), s.name(), "step", s.model(), s.privacy()));
            } else if (n instanceof Playbook.Decision d) {
                Playbook.Check c = p.checks().get(d.check());
                if (c != null && "review".equals(c.kind())) {
                    out.add(new Node(d.id(), d.name(), "review", c.model(), ReviewCheck.privacy(p, c.reads())));
                }
            }
        }
        return out;
    }

    /**
     * Reads the {@code picks} of a {@code start_playbook} frame. Absent or
     * null reads as no picks.
     *
     * @param picks the frame's field, or null
     * @return the picks, or the refusal of their shape
     */
    public static Read read(JsonNode picks) {
        if (picks == null || picks.isMissingNode() || picks.isNull()) {
            return new Read(Map.of(), null);
        }
        if (!picks.isObject() || picks.size() > MAX_PICKS) {
            return new Read(Map.of(), UNREADABLE);
        }
        Map<String, Playbook.ModelRef> out = new LinkedHashMap<>();
        for (Iterator<Map.Entry<String, JsonNode>> it = picks.fields(); it.hasNext(); ) {
            Map.Entry<String, JsonNode> e = it.next();
            JsonNode value = e.getValue();
            if (!plain(e.getKey(), MAX_NODE_CHARS) || !value.isObject()
                    || !plain(value.get("provider"), MAX_PROVIDER_CHARS) || !plain(value.get("model"), MAX_MODEL_CHARS)) {
                return new Read(Map.of(), UNREADABLE);
            }
            out.put(e.getKey(), new Playbook.ModelRef(value.get("provider").asText(), value.get("model").asText()));
        }
        return new Read(Map.copyOf(out), null);
    }

    private static boolean plain(JsonNode node, int max) {
        return node != null && node.isTextual() && plain(node.asText(), max);
    }

    private static boolean plain(String text, int max) {
        return !text.isBlank() && text.length() <= max && text.chars().noneMatch(Character::isISOControl);
    }

    /**
     * The model choice a node runs on in this run: the pick alone, without
     * fallbacks, when the node has one, else the playbook's choice.
     *
     * @param p      the playbook
     * @param nodeId the node
     * @param choice the choice the node names
     * @param picks  this run's picks
     * @return the choice to resolve
     */
    public static Playbook.ModelChoice choiceOf(Playbook p, String nodeId, String choice,
                                                Map<String, Playbook.ModelRef> picks) {
        Playbook.ModelRef pick = picks == null ? null : picks.get(nodeId);
        return pick != null ? new Playbook.ModelChoice(pick, List.of()) : p.models().get(choice);
    }

    /**
     * Fix round (review N4): the picks without those equal to their node's own
     * primary model. The page never sends one; a hand-made frame can, and it
     * would turn the node's choice into one without fallbacks and mark the
     * step as picked. A pick for a node that is not there stays, so the check
     * still refuses it.
     *
     * @param p     the pinned playbook
     * @param picks the picks as read
     * @return the picks that change a node's model
     */
    public static Map<String, Playbook.ModelRef> withoutDefaults(Playbook p, Map<String, Playbook.ModelRef> picks) {
        if (picks == null || picks.isEmpty()) {
            return Map.of();
        }
        Map<String, Node> byId = new HashMap<>();
        nodes(p).forEach(n -> byId.put(n.id(), n));
        Map<String, Playbook.ModelRef> out = new LinkedHashMap<>();
        picks.forEach((id, pick) -> {
            Node n = byId.get(id);
            Playbook.ModelChoice choice = n == null ? null : p.models().get(n.choice());
            if (choice == null || !choice.primary().equals(pick)) {
                out.put(id, pick);
            }
        });
        return Map.copyOf(out);
    }

    /**
     * The checks that need no provider: every pick names a node of the
     * playbook that runs on a model, and a provider the app knows. A server
     * runs them before it dials anything.
     *
     * @param p             the pinned playbook
     * @param picks         the picks as read
     * @param knownProvider whether the app knows a provider name
     * @return the first refusal in node id order, or null
     */
    public static String structuralRefusal(Playbook p, Map<String, Playbook.ModelRef> picks,
                                           Predicate<String> knownProvider) {
        if (picks == null || picks.isEmpty()) {
            return null;
        }
        Map<String, Node> byId = new HashMap<>();
        nodes(p).forEach(n -> byId.put(n.id(), n));
        for (String id : new TreeSet<>(picks.keySet())) {
            Playbook.ModelRef pick = picks.get(id);
            if (!byId.containsKey(id)) {
                return "The model pick names " + id + ", which is not a step of this playbook that runs on a model.";
            }
            if (!knownProvider.test(pick.provider())) {
                return "The model pick for " + id + " names " + pick.provider()
                        + ", which is not a provider this app knows.";
            }
        }
        return null;
    }

    /**
     * Checks the picks against the playbook first, then each picked provider
     * once, on a fresh check. Nothing is asked while any pick names a node or
     * a provider that does not exist.
     *
     * @param p             the pinned playbook
     * @param picks         the picks as read
     * @param knownProvider whether the app knows a provider name
     * @param probe         the fresh check of one provider
     * @return the first refusal in node id order, or null when every pick serves
     */
    public static String refusal(Playbook p, Map<String, Playbook.ModelRef> picks, Predicate<String> knownProvider,
                                 Function<String, Probe> probe) {
        if (picks == null || picks.isEmpty()) {
            return null;
        }
        String structural = structuralRefusal(p, picks, knownProvider);
        if (structural != null) {
            return structural;
        }
        Map<String, Node> byId = new HashMap<>();
        nodes(p).forEach(n -> byId.put(n.id(), n));
        TreeSet<String> ids = new TreeSet<>(picks.keySet());
        Map<String, Probe> asked = new HashMap<>();
        for (String id : ids) {
            ModelResolver.Resolution r = ModelResolver.resolve(new Playbook.ModelChoice(picks.get(id), List.of()),
                    byId.get(id).privacy(), provider -> asked.computeIfAbsent(provider, probe));
            if (r instanceof ModelResolver.Unavailable u) {
                return "The model pick for " + id + " does not serve: " + u.sentence() + ".";
            }
        }
        return null;
    }
}
