package dev.spectroscope.server.spectrolyzr;

import java.util.List;
import java.util.Map;

/**
 * The Spectrolyzr manifest, {@code <resourceRoot>/manifest.json} on the
 * classpath, as read by {@link ManifestReader}: the archetypes, languages and
 * add-ons a person picks from, and the parts that compose the files of one
 * choice. Templates live under {@code <resourceRoot>/templates/}.
 */
public record Manifest(int schemaVersion, List<Archetype> archetypes, List<Language> languages,
        List<Addon> addons, List<Part> parts, String resourceRoot) {

    /** A text in both languages of the UI. */
    public record Text(String en, String de) {}

    public record Archetype(String id, Text name, Text description) {}

    /** {@code commands} carries exactly the keys {@code test} and {@code gate}. */
    public record Language(String id, String name, Map<String, String> commands) {}

    public record Addon(String id, Text name, Text description) {}

    /** Each key is an id or null; null matches any value, the keys combine with AND. */
    public record When(String archetype, String language, String addon) {}

    public record Put(String path, String template, Text why) {}

    public record Append(String path, String template) {}

    public record WhyRule(String prefix, Text why) {}

    /** The JSON key is {@code import}; {@code setJson} maps a file to JSON pointer to template value. */
    public record Import(String from, Map<String, Map<String, String>> setJson, List<WhyRule> whyByPrefix) {}

    public record Part(String id, When when, String root, List<Put> put, List<Append> append, Import importFrom) {}
}
