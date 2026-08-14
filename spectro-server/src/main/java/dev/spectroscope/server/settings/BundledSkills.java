package dev.spectroscope.server.settings;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.core.io.Resource;
import org.springframework.core.io.support.PathMatchingResourcePatternResolver;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;

/**
 * First-start skill seeding (card 90): the repo's own skills ride every
 * artifact as {@code bundled-skills/&lt;name&gt;/SKILL.md} classpath resources
 * (see spectro-server's processResources) and land in {@code ~/.spectro/skills}
 * exactly once. A name may carry ONE directory level (card 207): a bundled
 * {@code spectroscope/research} seeds nested and the card-182 pack rule then
 * advertises it namespaced, as {@code spectroscope:research}. Two promises,
 * both pinned: a user's EDIT is never overwritten (absent-only copy) and a
 * user's DELETION sticks — the {@code .seeded} ledger remembers every skill
 * ever offered, so a removed folder is not re-seeded.
 */
public final class BundledSkills {

    private static final Logger log = LoggerFactory.getLogger(BundledSkills.class);

    /** The ledger file in the target root — one offered skill name per line. */
    static final String LEDGER = ".seeded";

    private BundledSkills() {
    }

    /** Boot entry: enumerate the classpath bundle and seed the user home.
     *  Failures warn and never break the boot — seeding is a courtesy. */
    public static void seedFromClasspath() {
        try {
            Map<String, String> bundled = readBundle();
            if (bundled.isEmpty()) {
                return; // dev run without the processResources copy — nothing to offer
            }
            Path target = Path.of(System.getProperty("user.home"), ".spectro", "skills");
            List<String> seeded = seed(bundled, target);
            if (!seeded.isEmpty()) {
                log.info("seeded {} bundled skill(s) into {}: {}", seeded.size(), target, seeded);
            }
        } catch (Exception failure) {
            log.warn("bundled-skill seeding skipped ({})", failure.toString());
        }
    }

    /** The anchor readBundle keys names off — the classpath folder the artifact carries. */
    private static final String BUNDLE_ROOT = "bundled-skills/";

    /**
     * The classpath bundle as name -> SKILL.md body. The name is the directory
     * path below the bundle root: {@code verification} for a flat skill,
     * {@code spectroscope/research} for a PACK skill (card 207) — one level of
     * nesting, exactly the shape the card-182 pack rule reads back out of the
     * skills root as {@code <pack>:<name>}. The path is cut at the literal
     * anchor rather than by counting separators, because a Spring Boot fat jar
     * spells its resource URLs with an unknowable number of segments ahead of
     * the bundle (see SkillCatalogue.relativeAfter, same reasoning).
     */
    static Map<String, String> readBundle() throws IOException {
        Map<String, String> bundled = new LinkedHashMap<>();
        Resource[] found = new PathMatchingResourcePatternResolver()
                .getResources("classpath*:" + BUNDLE_ROOT + "**/SKILL.md");
        for (Resource resource : found) {
            String url = String.valueOf(resource.getURL());
            String rel = SkillCatalogue.relativeAfter(url, BUNDLE_ROOT);
            if (rel == null || !rel.endsWith("/SKILL.md")) {
                continue; // never guessed, only skipped
            }
            String name = rel.substring(0, rel.length() - "/SKILL.md".length());
            try (var in = resource.getInputStream()) {
                bundled.put(name, new String(in.readAllBytes(), StandardCharsets.UTF_8));
            }
        }
        return bundled;
    }

    /**
     * Seeds every bundled skill whose folder is absent AND whose name is not in
     * the ledger yet; each processed name joins the ledger so later boots leave
     * the user's world alone.
     *
     * @param bundled    skill name -> SKILL.md body
     * @param targetRoot the user's skills root (e.g. ~/.spectro/skills)
     * @return the names actually written this time
     */
    static List<String> seed(Map<String, String> bundled, Path targetRoot) throws IOException {
        Files.createDirectories(targetRoot);
        Path ledgerFile = targetRoot.resolve(LEDGER);
        Set<String> offered = Files.isRegularFile(ledgerFile)
                ? Set.copyOf(Files.readAllLines(ledgerFile))
                : Set.of();
        List<String> written = new ArrayList<>();
        StringBuilder ledgerAppend = new StringBuilder();
        for (Map.Entry<String, String> skill : bundled.entrySet()) {
            String name = skill.getKey();
            Path dir = targetRoot.resolve(name);
            boolean exists = Files.exists(dir);
            if (!exists && !offered.contains(name)) {
                Files.createDirectories(dir);
                Files.writeString(dir.resolve("SKILL.md"), skill.getValue());
                written.add(name);
            }
            if (!offered.contains(name)) {
                ledgerAppend.append(name).append('\n');
            }
        }
        if (ledgerAppend.length() > 0) {
            Files.writeString(ledgerFile, ledgerAppend.toString(),
                    java.nio.file.StandardOpenOption.CREATE, java.nio.file.StandardOpenOption.APPEND);
        }
        return written;
    }
}
