package dev.spectroscope.server.playbooks;

import dev.spectroscope.core.graph.Topology;
import dev.spectroscope.core.playbook.Finding;
import dev.spectroscope.core.playbook.Playbook;
import dev.spectroscope.core.playbook.run.CommandCheck;
import dev.spectroscope.core.playbook.run.PinnedPlaybook;
import dev.spectroscope.core.playbook.run.PlaybookRunner;
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
 * @param dir       the playbook folder's real path
 * @param hash      the start hash over the pinned bytes, or null when the playbook did not load
 * @param topology  the drawing, or null when the playbook did not load
 * @param findings  what the reader and the validator found
 * @param steps     one row per step in node order
 * @param skills    one row per skill a step names, in node order
 * @param commands  every command check line after var substitution, in node order
 * @param refusals  every reason the start is refused; empty when it may start
 */
public record PlaybookStartPreview(String dir, String hash, Topology topology, List<Finding> findings,
                                   List<StepPlan> steps, List<SkillPlan> skills, List<String> commands,
                                   List<String> refusals) {

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
     * @param loaded  the folder as the loader read it
     * @param pinned  the pinned bytes, or null when the playbook did not load
     * @param row     the registry row of a provider by name, or null for one it does not know
     * @param canAsk  whether a person can answer here; a browser can
     * @return the preview
     */
    public static PlaybookStartPreview of(PlaybookLoader.Loaded loaded, PinnedPlaybook pinned,
                                          Function<String, ProviderRow> row, boolean canAsk) {
        List<String> refusals = new ArrayList<>();
        if (pinned == null || loaded.playbook() == null) {
            loaded.findings().forEach(f -> refusals.add(f.path() + ": " + f.message()));
            return new PlaybookStartPreview(loaded.dir(), null, loaded.topology(), loaded.findings(), List.of(),
                    List.of(), List.of(), List.copyOf(refusals));
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
        refusals.addAll(PlaybookRunner.refusals(pinned, canAsk, provider -> {
            ProviderRow r = row.apply(provider);
            return r == null ? "cloud" : r.kind();
        }));
        loaded.findings().forEach(f -> refusals.add(f.path() + ": " + f.message()));
        return new PlaybookStartPreview(loaded.dir(), pinned.hash(), loaded.topology(), loaded.findings(),
                List.copyOf(steps), List.copyOf(skills), List.copyOf(commands), List.copyOf(refusals));
    }

    private static String sourceOf(PinnedPlaybook pinned, String skill) {
        if (pinned.missingSkills().contains(skill)) {
            return "missing";
        }
        var body = pinned.skills().get(skill);
        return body == null ? "missing" : body.source();
    }
}
