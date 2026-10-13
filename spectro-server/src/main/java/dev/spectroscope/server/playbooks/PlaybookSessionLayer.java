package dev.spectroscope.server.playbooks;

import dev.spectroscope.core.playbook.AgentFile;
import dev.spectroscope.core.playbook.Playbook;
import dev.spectroscope.core.playbook.PlaybookReader;
import dev.spectroscope.core.playbook.PlaybookValidator;
import dev.spectroscope.core.skills.SessionCatalogue;
import dev.spectroscope.core.skills.Skill;
import dev.spectroscope.core.skills.SkillLibrary;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.LinkOption;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

/**
 * Card 558: the skills, commands and agents a picked playbook gives a session,
 * read from the playbook folder in place. The items are exactly the ones
 * {@link PlaybookContents} lists (an item with a finding is left out), and
 * nothing is written anywhere: no copy into {@code ~/.spectro} or the
 * workspace, nothing under the playbook folder.
 *
 * <p>A playbook's skill goes by its folder name, a command by its file name and
 * an agent by its name; the pack folder a skill sits in is the playbook's own
 * order and not part of the name the session reads. When two of the playbook's
 * skills share a name, they take {@code <pack>:<name>} so that the playbook's
 * own names stay unique; a skill and a command of one name both stay, and the
 * session's catalogue puts the command under the playbook's id (review
 * finding 2). A playbook whose id is not a valid id gives no items: the id
 * would become a namespace (review finding 4).
 */
public final class PlaybookSessionLayer {

    private PlaybookSessionLayer() {
    }

    /**
     * The playbook's layer and what the page shows of the playbook.
     *
     * @param layer   the items, or null when the playbook gives none
     * @param id      the playbook's id
     * @param name    the playbook's name
     * @param refusal why the playbook gives no items, or null when it does
     */
    public record Read(SessionCatalogue.Layer layer, String id, String name, String refusal) {
    }

    /**
     * @param id the id the playbook file gives
     * @return the line a session hears when its picked playbook's id is not a valid id
     */
    public static String invalidId(String id) {
        return "The picked playbook's id \"" + id + "\" is not a valid playbook id (lowercase letters, digits"
                + " and dashes, starting with a letter), so its skills, commands and agents are not read.";
    }

    /**
     * @param folder        a registered playbook folder
     * @param spectroHome   {@code ~/.spectro}
     * @return the layer, or null when the folder holds no playbook that reads
     */
    public static Read read(Path folder, Path spectroHome) {
        try {
            Path root = folder.toRealPath();
            Path file = root.resolve(PlaybookFolders.PLAYBOOK_FILE);
            if (!Files.isRegularFile(file, LinkOption.NOFOLLOW_LINKS) || Files.size(file) > PlaybookContents.MAX_TEXT_BYTES) {
                return null;
            }
            Playbook p = PlaybookReader.read(Files.readString(file, StandardCharsets.UTF_8)).playbook();
            if (p == null) {
                return null;
            }
            if (!PlaybookValidator.validId(p.id())) {
                return new Read(null, p.id(), p.name(), invalidId(p.id()));
            }
            List<PlaybookContents.Item> items = PlaybookContents.listing(root, p, spectroHome).items();
            Map<String, Integer> bare = new HashMap<>();
            for (PlaybookContents.Item i : items) {
                if ("skill".equals(i.kind())) {
                    bare.merge(bareName(i), 1, Integer::sum);
                }
            }
            List<SessionCatalogue.Entry> entries = new ArrayList<>();
            for (PlaybookContents.Item i : items) {
                SessionCatalogue.Entry e = entry(root, i, bare);
                if (e != null) {
                    entries.add(e);
                }
            }
            return new Read(new SessionCatalogue.Layer(SessionCatalogue.PLAYBOOK,
                    SessionCatalogue.playbookNamespace(p.id()), entries), p.id(), p.name(), null);
        } catch (IOException | RuntimeException unreadable) {
            return null;
        }
    }

    /** The name an item goes by in the playbook before any clash: folder, file stem or agent name. */
    private static String bareName(PlaybookContents.Item i) {
        String source = i.source();
        String last = source.substring(source.lastIndexOf('/') + 1);
        return last.endsWith(".md") && !"skill".equals(i.kind()) ? last.substring(0, last.length() - 3) : last;
    }

    private static SessionCatalogue.Entry entry(Path root, PlaybookContents.Item i, Map<String, Integer> bare)
            throws IOException {
        Path at = root.resolve(i.source()).normalize();
        if (!at.startsWith(root)) {
            return null;
        }
        switch (i.kind()) {
            case "skill" -> {
                Path skillFile = at.resolve("SKILL.md");
                String raw = text(skillFile);
                if (raw == null) {
                    return null;
                }
                String folder = at.getFileName().toString();
                Skill parsed = SkillLibrary.parse(raw, folder, skillFile);
                String plain = bare.getOrDefault(folder, 0) > 1 ? i.name() : folder;
                return new SessionCatalogue.Entry(SessionCatalogue.SKILL, plain, parsed.description(), parsed.body(),
                        skillFile, null);
            }
            case "command" -> {
                String raw = text(at);
                if (raw == null) {
                    return null;
                }
                String stem = bareName(i);
                return new SessionCatalogue.Entry(SessionCatalogue.COMMAND, stem,
                        PlaybookContents.frontmatterDescription(raw), SkillLibrary.parse(raw, stem, at).body(), at, null);
            }
            case "agent" -> {
                String raw = text(at);
                AgentFile.Read read = raw == null ? null : AgentFile.read(raw, i.source());
                if (read == null || read.agent() == null || !read.findings().isEmpty()) {
                    return null;
                }
                AgentFile a = read.agent();
                return new SessionCatalogue.Entry(SessionCatalogue.AGENT, a.name(), a.description(), a.preamble(), at,
                        a.type());
            }
            default -> {
                return null;
            }
        }
    }

    /** A regular file under the size the listing reads, as text; null otherwise. */
    private static String text(Path file) throws IOException {
        if (!Files.isRegularFile(file, LinkOption.NOFOLLOW_LINKS) || Files.size(file) > PlaybookContents.MAX_TEXT_BYTES) {
            return null;
        }
        return Files.readString(file, StandardCharsets.UTF_8);
    }
}
