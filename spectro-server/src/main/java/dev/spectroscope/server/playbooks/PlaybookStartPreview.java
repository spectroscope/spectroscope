package dev.spectroscope.server.playbooks;

import dev.spectroscope.core.config.SpectroConfig;
import dev.spectroscope.core.graph.Topology;
import dev.spectroscope.core.playbook.Finding;
import dev.spectroscope.core.playbook.Playbook;
import dev.spectroscope.core.playbook.run.CommandCheck;
import dev.spectroscope.core.playbook.run.ModelPicks;
import dev.spectroscope.core.playbook.run.ModelResolver;
import dev.spectroscope.core.playbook.run.PinnedPlaybook;
import dev.spectroscope.core.playbook.run.PlaybookRunner;
import dev.spectroscope.core.playbook.run.Probe;
import dev.spectroscope.server.providers.ProviderRow;

import java.util.ArrayList;
import java.util.List;
import java.util.function.Function;

/**
 * What the confirmation sheet shows before a playbook run starts: the
 * drawing, a line per step with the model it will run on and the state of
 * that model's provider, the skills with their source, every command check
 * verbatim, the hash the start frame must repeat, and every reason the start
 * is refused.
 *
 * <p>Card 584: also, per node that runs on a model, whether a model of its
 * choice serves and why not, decided by the run's own {@link ModelResolver};
 * and the models of every provider whose list answered, which the sheet
 * offers as picks for this run. A private step on a cloud model is that
 * step's reason, which a local pick lifts, and not one of the refusals.</p>
 *
 * @param dir       the playbook folder's real path
 * @param hash      the start hash over the pinned bytes, or null when the playbook did not load
 * @param topology  the drawing, or null when the playbook did not load
 * @param findings  what the reader and the validator found
 * @param steps     one row per step in node order
 * @param skills    one row per skill a step names, in node order
 * @param commands  every command check line after var substitution, in node order
 * @param refusals  every reason the start is refused that no model pick lifts; empty when it may start
 * @param models    one row per node that runs on a model, in node order (card 584)
 * @param offers    one row per provider whose model list answered, in provider order (card 584)
 */
public record PlaybookStartPreview(String dir, String hash, Topology topology, List<Finding> findings,
                                   List<StepPlan> steps, List<SkillPlan> skills, List<String> commands,
                                   List<String> refusals, List<ModelCheck> models, List<ModelOffer> offers) {

    /**
     * One step as the table shows it.
     *
     * @param id            the node id
     * @param name          the step's name
     * @param performer     chat or child
     * @param role          the child's role, or null
     * @param choice        the model choice the step names
     * @param provider      the provider of the choice's primary model
     * @param model         the primary model
     * @param providerKind  local, cloud or builtin; an unknown provider reads as cloud
     * @param providerState the registry's state word, or unknown
     * @param privacy       private or cheap
     * @param permission    the step's permission floor, or inherit
     * @param nod           whether the step waits for a person's nod
     */
    public record StepPlan(String id, String name, String performer, String role, String choice, String provider,
                           String model, String providerKind, String providerState, String privacy,
                           String permission, boolean nod) {}

    /**
     * One skill a step names and where it comes from.
     *
     * @param name   the skill as a step names it
     * @param source playbook, installed or missing
     */
    public record SkillPlan(String name, String source) {}

    /**
     * Card 584: whether a node that runs on a model has one that serves.
     *
     * @param node        the node id
     * @param name        the node's name
     * @param kind        {@code step} or {@code review}
     * @param choice      the model choice the node names
     * @param privacy     private or cheap
     * @param provider    the provider of the playbook's primary model
     * @param model       the playbook's primary model
     * @param serves      true when a model of the choice serves
     * @param viaProvider the provider of a fallback that serves in place of the primary, else null
     * @param viaModel    the model of that fallback, else null
     * @param reason      null when it serves; else why the primary does not, one word of
     *                    {@link ModelResolver.Unavailable#code()}
     * @param httpStatus  the HTTP status of the primary's failed check, or null
     * @param keySource   for {@code rejected-key} only: {@code environment} or {@code saved}, never the
     *                    key; else null
     */
    public record ModelCheck(String node, String name, String kind, String choice, String privacy, String provider,
                             String model, boolean serves, String viaProvider, String viaModel, String reason,
                             Integer httpStatus, String keySource) {}

    /**
     * Card 584: a provider whose model list answered, and its models, which
     * the sheet offers as picks.
     *
     * @param provider the provider name
     * @param kind     local or cloud; a private node is offered local providers only
     * @param models   the models of its live list
     */
    public record ModelOffer(String provider, String kind, List<String> models) {}

    /**
     * The preview with the key source of this process and every known provider's row for the offers.
     *
     * @param loaded  the folder as the loader read it
     * @param pinned  the pinned bytes, or null when the playbook did not load
     * @param row     the registry row of a provider by name, or null for one it does not know
     * @param canAsk  whether a person can answer here; a browser can
     * @return the preview
     */
    public static PlaybookStartPreview of(PlaybookLoader.Loaded loaded, PinnedPlaybook pinned,
                                          Function<String, ProviderRow> row, boolean canAsk) {
        return of(loaded, pinned, row, canAsk,
                provider -> SpectroConfig.apiKeySource(SpectroConfig.keyEnvFor(provider)));
    }

    /**
     * The preview with every known provider's row for the offers.
     *
     * @param loaded    the folder as the loader read it
     * @param pinned    the pinned bytes, or null when the playbook did not load
     * @param row       the registry row of a provider by name, or null for one it does not know
     * @param canAsk    whether a person can answer here; a browser can
     * @param keySource where a provider's key comes from, {@code environment}, {@code saved} or null;
     *                  asked only for a rejected key
     * @return the preview
     */
    public static PlaybookStartPreview of(PlaybookLoader.Loaded loaded, PinnedPlaybook pinned,
                                          Function<String, ProviderRow> row, boolean canAsk,
                                          Function<String, String> keySource) {
        return of(loaded, pinned, row, canAsk, keySource, SpectroConfig.knownProviders().stream().sorted().toList());
    }

    /**
     * The preview over the given rows.
     *
     * @param loaded    the folder as the loader read it
     * @param pinned    the pinned bytes, or null when the playbook did not load
     * @param row       the registry row of a provider by name, or null for one it does not know
     * @param canAsk    whether a person can answer here; a browser can
     * @param keySource where a provider's key comes from, {@code environment}, {@code saved} or null;
     *                  asked only for a rejected key
     * @param providers the providers whose rows may offer models, in the order offered
     * @return the preview
     */
    public static PlaybookStartPreview of(PlaybookLoader.Loaded loaded, PinnedPlaybook pinned,
                                          Function<String, ProviderRow> row, boolean canAsk,
                                          Function<String, String> keySource, List<String> providers) {
        List<String> refusals = new ArrayList<>();
        if (pinned == null || loaded.playbook() == null) {
            loaded.findings().forEach(f -> refusals.add(f.path() + ": " + f.message()));
            return new PlaybookStartPreview(loaded.dir(), null, loaded.topology(), loaded.findings(), List.of(),
                    List.of(), List.of(), List.copyOf(refusals), List.of(), List.of());
        }
        Playbook p = loaded.playbook();
        List<StepPlan> steps = new ArrayList<>();
        List<SkillPlan> skills = new ArrayList<>();
        List<String> commands = new ArrayList<>();
        List<String> seen = new ArrayList<>();
        for (Playbook.Node n : p.nodes()) {
            if (n instanceof Playbook.Step s) {
                Playbook.ModelRef ref = p.models().get(s.model()).primary();
                ProviderRow provider = row.apply(ref.provider());
                steps.add(new StepPlan(s.id(), s.name(), s.performer(), s.role(), s.model(), ref.provider(),
                        ref.model(), provider == null ? "cloud" : provider.kind(),
                        provider == null ? "unknown" : provider.state(), s.privacy(), s.permission(), s.nod()));
                for (String skill : s.skills()) {
                    if (!seen.contains(skill)) {
                        seen.add(skill);
                        skills.add(new SkillPlan(skill, sourceOf(pinned, skill)));
                    }
                }
            } else if (n instanceof Playbook.Decision d) {
                Playbook.Check c = p.checks().get(d.check());
                if ("command".equals(c.kind())) {
                    commands.add(CommandCheck.substitute(c.run(), p.vars()));
                }
            }
        }
        refusals.addAll(PlaybookRunner.refusalsBesideModels(pinned, canAsk));
        loaded.findings().forEach(f -> refusals.add(f.path() + ": " + f.message()));
        return new PlaybookStartPreview(loaded.dir(), pinned.hash(), loaded.topology(), loaded.findings(),
                List.copyOf(steps), List.copyOf(skills), List.copyOf(commands), List.copyOf(refusals),
                modelChecks(p, row, keySource), offers(row, providers));
    }

    /** One row per node that runs on a model, by the run's own resolver over these rows. */
    private static List<ModelCheck> modelChecks(Playbook p, Function<String, ProviderRow> row,
                                                Function<String, String> keySource) {
        List<ModelCheck> out = new ArrayList<>();
        for (ModelPicks.Node n : ModelPicks.nodes(p)) {
            Playbook.ModelChoice choice = p.models().get(n.choice());
            Playbook.ModelRef primary = choice.primary();
            ModelResolver.Resolution r = ModelResolver.resolve(choice, n.privacy(),
                    provider -> probeOf(provider, row.apply(provider)));
            if (r instanceof ModelResolver.Resolved ok) {
                boolean fallback = !ok.ref().equals(primary);
                out.add(new ModelCheck(n.id(), n.name(), n.kind(), n.choice(), n.privacy(), primary.provider(),
                        primary.model(), true, fallback ? ok.ref().provider() : null,
                        fallback ? ok.ref().model() : null, null, null, null));
            } else {
                ModelResolver.Unavailable u = (ModelResolver.Unavailable) r;
                String reason = u.code();
                ProviderRow failed = row.apply(u.ref().provider());
                out.add(new ModelCheck(n.id(), n.name(), n.kind(), n.choice(), n.privacy(), primary.provider(),
                        primary.model(), false, null, null, reason, failed == null ? null : failed.httpStatus(),
                        "rejected-key".equals(reason) ? keySource.apply(u.ref().provider()) : null));
            }
        }
        return List.copyOf(out);
    }

    /** A registry row as the resolver reads it; a provider the registry does not know reads as cloud and unknown. */
    private static Probe probeOf(String provider, ProviderRow r) {
        if (r == null) {
            return new Probe(provider, "cloud", "unknown", null, null, List.of(), false, 0L);
        }
        return new Probe(r.id(), r.kind(), r.state(), r.endpoint(), r.reason(), r.models(), r.live(), r.checkedAt());
    }

    /** The providers whose list answered with at least one model. */
    private static List<ModelOffer> offers(Function<String, ProviderRow> row, List<String> providers) {
        List<ModelOffer> out = new ArrayList<>();
        for (String id : providers) {
            ProviderRow r = row.apply(id);
            if (r != null && "reachable".equals(r.state()) && r.live() && !r.models().isEmpty()) {
                out.add(new ModelOffer(r.id(), r.kind(), List.copyOf(r.models())));
            }
        }
        return List.copyOf(out);
    }

    private static String sourceOf(PinnedPlaybook pinned, String skill) {
        if (pinned.missingSkills().contains(skill)) {
            return "missing";
        }
        var body = pinned.skills().get(skill);
        return body == null ? "missing" : body.source();
    }
}
