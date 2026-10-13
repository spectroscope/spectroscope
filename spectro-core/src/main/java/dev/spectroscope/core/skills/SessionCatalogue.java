package dev.spectroscope.core.skills;

import java.nio.file.Path;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.Set;

/**
 * Card 558: the skills, commands and agents one session sees, merged from its
 * sources (the workspace, the picked playbook and the user's folders; card 587
 * adds the app's own skills) under the owner's rule of 2026-10-12. A name that exists once keeps its plain form. A
 * name that exists more than once stays in every source, each under a namespace
 * that names the source ({@code workspace:}, {@code user:}, the playbook's id),
 * and no source wins.
 *
 * <p>Skills and commands share one name space, because both are called as
 * {@code /name}. Agents have their own. Every effective name is unique: a
 * namespaced name that meets another item's name is namespaced again, so the
 * user's pack skill {@code workspace:foo} and the workspace's doubled
 * {@code foo} cannot end up with one name.
 *
 * <p>Immutable. Nothing here reads or writes a file: the layers come in read.
 */
public final class SessionCatalogue {

    /** The source word of the workspace layer, and its namespace. */
    public static final String WORKSPACE = "workspace";
    /** The source word of the picked playbook's layer; its namespace is the playbook's id. */
    public static final String PLAYBOOK = "playbook";
    /** The source word of the user's folders, and their namespace. */
    public static final String USER = "user";
    /** Card 587: the source word of the skills the app itself ships, and their namespace. */
    public static final String APP = "app";

    /** Card 587, fix round: every source word, in the order the pages list the sources. */
    public static final List<String> SOURCES = List.of(WORKSPACE, PLAYBOOK, USER, APP);

    /** A skill: a folder with a SKILL.md. */
    public static final String SKILL = "skill";
    /** A command: a prompt file, called as {@code /name} like a skill. */
    public static final String COMMAND = "command";
    /** An agent: a preamble and a child type. */
    public static final String AGENT = "agent";

    /**
     * One thing a source brings, under the name it has in that source.
     *
     * @param kind        {@link #SKILL}, {@link #COMMAND} or {@link #AGENT}
     * @param plain       the name in its source; unique per source and name space
     * @param description one line
     * @param body        the skill body, the command text or the agent preamble
     * @param path        the file it was read from, or null
     * @param agentType   the child type of an agent, null for the other kinds
     */
    public record Entry(String kind, String plain, String description, String body, Path path, String agentType) {
    }

    /**
     * One source.
     *
     * @param source    {@link #WORKSPACE}, {@link #PLAYBOOK} or {@link #USER}
     * @param namespace the word a doubled name is put under
     * @param entries   what it brings
     */
    public record Layer(String source, String namespace, List<Entry> entries) {

        /**
         * @param entries what the layer brings; copied
         * @throws IllegalArgumentException for a source outside {@link #SOURCES}
         */
        public Layer {
            if (!SOURCES.contains(source)) {
                throw new IllegalArgumentException("not a source of the session catalogue: " + source);
            }
            entries = List.copyOf(entries);
        }

        /**
         * A layer of skills under the names a {@link SkillLibrary} gives them.
         *
         * @param source {@link #WORKSPACE} or {@link #USER}, also the namespace
         * @param skills the skills of one root
         * @return the layer
         */
        public static Layer ofSkills(String source, List<Skill> skills) {
            List<Entry> entries = new ArrayList<>();
            for (Skill s : skills) {
                entries.add(new Entry(SKILL, s.name(), s.description(), s.body(), s.source(), null));
            }
            return new Layer(source, source, entries);
        }
    }

    /**
     * One item as the session sees it.
     *
     * @param kind        {@link #SKILL}, {@link #COMMAND} or {@link #AGENT}
     * @param name        the effective name, unique in its name space
     * @param plain       the name in its source
     * @param source      {@link #WORKSPACE}, {@link #PLAYBOOK} or {@link #USER}
     * @param namespace   the word the name is put under when it is doubled
     * @param description one line
     * @param body        the skill body, the command text or the agent preamble
     * @param path        the file it was read from, or null
     * @param agentType   the child type of an agent, null for the other kinds
     */
    public record Item(String kind, String name, String plain, String source, String namespace, String description,
                       String body, Path path, String agentType) {
    }

    private final List<Item> items;
    private final SkillLibrary library;

    private SessionCatalogue(List<Item> items) {
        this.items = List.copyOf(items);
        List<Skill> skills = new ArrayList<>();
        for (Item i : items) {
            if (!AGENT.equals(i.kind())) {
                skills.add(new Skill(i.name(), i.description(), i.body(), i.path()));
            }
        }
        this.library = SkillLibrary.of(skills);
    }

    /**
     * Merges the layers under the owner's rule.
     *
     * @param layers the sources, in the order workspace, playbook, user; any may be absent
     * @return the catalogue
     */
    public static SessionCatalogue of(List<Layer> layers) {
        return of(layers, Set.of());
    }

    /**
     * Merges the layers under the owner's rule. A skill or command whose plain
     * name is a built-in chat command is always put under its source's
     * namespace, also when the name exists once, so it stays reachable and
     * never shadows the built-in (integrator decisions, card 558 rounds 2 and 3).
     *
     * @param layers   the sources, in the order workspace, playbook, user; any may be absent
     * @param builtIns the words of the web chat's commands, {@code CommandList.webFirstWords()}
     * @return the catalogue
     */
    public static SessionCatalogue of(List<Layer> layers, Set<String> builtIns) {
        List<Item> out = new ArrayList<>();
        out.addAll(nameSpace(layers, false, builtIns));
        out.addAll(nameSpace(layers, true, Set.of()));
        out.sort(Comparator.comparing(Item::kind).thenComparing(Item::name));
        return new SessionCatalogue(out);
    }

    /**
     * The namespace of a playbook's items: its id, unless the id is one of the
     * other source words, which would put two sources under one word.
     *
     * @param id the playbook's id
     * @return the namespace
     */
    public static String playbookNamespace(String id) {
        return WORKSPACE.equals(id) || USER.equals(id) || APP.equals(id) ? PLAYBOOK + "-" + id : id;
    }

    /** The items of one name space (agents, or skills and commands), with effective names. */
    private static List<Item> nameSpace(List<Layer> layers, boolean agents, Set<String> builtIns) {
        List<Layer> sources = new ArrayList<>();
        List<Entry> entries = new ArrayList<>();
        // One entry per kind and name in a layer; a skill and a command of one
        // name both stay (review finding 2).
        Set<String> seen = new LinkedHashSet<>();
        for (Layer layer : layers) {
            seen.clear();
            for (Entry e : layer.entries()) {
                if (AGENT.equals(e.kind()) == agents && seen.add(e.kind() + "\u0000" + e.plain())) {
                    sources.add(layer);
                    entries.add(e);
                }
            }
        }
        String[] names = effectiveNames(sources, entries, builtIns);
        List<Item> out = new ArrayList<>();
        for (int i = 0; i < entries.size(); i++) {
            Entry e = entries.get(i);
            Layer l = sources.get(i);
            out.add(new Item(e.kind(), names[i], e.plain(), l.source(), l.namespace(), e.description(), e.body(),
                    e.path(), e.agentType()));
        }
        return out;
    }

    /**
     * The rule: every entry starts with its plain name; while two entries share
     * a name, each of them that still carries its plain name is put under its
     * source's namespace. A command whose source also holds a skill of that
     * name, and one named like a built-in, starts under the namespace; the skill
     * keeps the plain name. When two entries of one source still share a name
     * (that skill namespaced as well), the command also names its kind:
     * {@code <namespace>:command:<name>}. Each round changes at least one entry
     * or stops, so it ends after at most two rounds per entry.
     */
    private static String[] effectiveNames(List<Layer> sources, List<Entry> entries, Set<String> builtIns) {
        String[] names = new String[entries.size()];
        boolean[] namespaced = new boolean[entries.size()];
        boolean[] kindNamed = new boolean[entries.size()];
        Set<String> skillsOfSource = new java.util.HashSet<>();
        for (int i = 0; i < names.length; i++) {
            if (SKILL.equals(entries.get(i).kind())) {
                skillsOfSource.add(sources.get(i).source() + "\u0000" + entries.get(i).plain());
            }
        }
        for (int i = 0; i < names.length; i++) {
            names[i] = entries.get(i).plain();
            boolean besideASkill = COMMAND.equals(entries.get(i).kind())
                    && skillsOfSource.contains(sources.get(i).source() + "\u0000" + names[i]);
            if (builtIns.contains(names[i]) || besideASkill) {
                names[i] = sources.get(i).namespace() + NAMESPACE_SEPARATOR + names[i];
                namespaced[i] = true;
            }
        }
        for (int round = 0; round <= 2 * names.length; round++) {
            Map<String, List<Integer>> byName = new LinkedHashMap<>();
            for (int i = 0; i < names.length; i++) {
                byName.computeIfAbsent(names[i], n -> new ArrayList<>()).add(i);
            }
            boolean changed = false;
            for (List<Integer> holders : byName.values()) {
                if (holders.size() < 2) {
                    continue;
                }
                boolean moved = false;
                for (int i : holders) {
                    if (!namespaced[i]) {
                        names[i] = sources.get(i).namespace() + NAMESPACE_SEPARATOR + names[i];
                        namespaced[i] = true;
                        moved = true;
                    }
                }
                if (!moved) {
                    for (int i : holders) {
                        if (COMMAND.equals(entries.get(i).kind()) && !kindNamed[i]) {
                            names[i] = sources.get(i).namespace() + NAMESPACE_SEPARATOR + COMMAND
                                    + NAMESPACE_SEPARATOR + entries.get(i).plain();
                            kindNamed[i] = true;
                            moved = true;
                        }
                    }
                }
                changed |= moved;
            }
            if (!changed) {
                break;
            }
        }
        return names;
    }

    private static final String NAMESPACE_SEPARATOR = SkillLibrary.NAMESPACE_SEPARATOR;

    /** @return every item, skills and commands and agents, sorted by kind and name */
    public List<Item> items() {
        return items;
    }

    /**
     * @param name an effective name of a skill or a command
     * @return the item, or empty when no skill or command has that name
     */
    public Optional<Item> find(String name) {
        return items.stream().filter(i -> !AGENT.equals(i.kind()) && i.name().equals(name)).findFirst();
    }

    /** @return the skills and commands as one library under their effective names */
    public SkillLibrary library() {
        return library;
    }

    /** @return the agents, sorted by name */
    public List<Item> agents() {
        return items.stream().filter(i -> AGENT.equals(i.kind())).toList();
    }
}
