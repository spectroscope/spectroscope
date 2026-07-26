package dev.spectroscope.core.leveling;

import com.fasterxml.jackson.annotation.JsonCreator;
import com.fasterxml.jackson.annotation.JsonIgnoreProperties;
import com.fasterxml.jackson.databind.ObjectMapper;

import java.io.IOException;
import java.io.InputStream;
import java.io.UncheckedIOException;
import java.nio.charset.StandardCharsets;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Objects;

/**
 * The ladder: seven states an operator grows through, and the criteria that
 * open each one (konzept/LEVELING.md §2). Loaded from
 * {@code /leveling/levels.json} in this module's resources, which is the
 * single source for the engine, the web UI, {@code spectro level} and any
 * generated poster — one file, so the copies cannot drift.
 *
 * <p>The ladder carries no copy: levels and criteria name i18n keys, and the
 * faces resolve them. It also carries no policy. Nothing here decides what a
 * level may do; the server reports state and the client renders locks, so
 * REST, CLI and MCP behave identically at level 0 and level 6.</p>
 */
public final class Ladder {

    private static final ObjectMapper JSON = new ObjectMapper();
    private static final String RESOURCE = "/leveling/levels.json";

    /** Where a criterion's evidence comes from, which decides who may mark it. */
    public enum Source {
        /** Derived from a fact the server can check itself (a ready provider, a green probe). */
        STATE,
        /** Folded out of the live RunEvent stream of a run in this home. */
        EVENT,
        /** A pure-view act the stream never sees, reported by the face as a visit beacon. */
        BEACON,
        /** A beacon that only counts when the session behind it also shows a stream fact. */
        JOINED;

        /** @param raw the lowercase wire spelling in levels.json
         *  @return the constant, never null
         *  @throws IllegalArgumentException naming the offending value */
        @JsonCreator
        public static Source fromJson(String raw) {
            Objects.requireNonNull(raw, "source");
            return valueOf(raw.toUpperCase(Locale.ROOT).replace('-', '_'));
        }
    }

    /** One rung: what it opens, and which criteria have to be met to leave it. */
    @JsonIgnoreProperties(ignoreUnknown = true)
    public record Level(int index, String id, String nameKey, String blurbKey,
                        List<String> opens, List<String> advanceWhen) {
        /** @param index dense position, 0-based
         *  @param id the stable kebab-case id
         *  @param nameKey i18n key of the display name
         *  @param blurbKey i18n key of the one-line description
         *  @param opens surface ids this level makes available
         *  @param advanceWhen criteria that must all be marked to reach the next rung */
        public Level {
            requireKey(id, "level id");
            requireKey(nameKey, "nameKey of " + id);
            requireKey(blurbKey, "blurbKey of " + id);
            opens = List.copyOf(Objects.requireNonNullElse(opens, List.of()));
            advanceWhen = List.copyOf(Objects.requireNonNullElse(advanceWhen, List.of()));
        }
    }

    /** One observable thing an operator does, and how the engine learns about it. */
    @JsonIgnoreProperties(ignoreUnknown = true)
    public record Criterion(String id, int level, Source source, String surface,
                            String requires, boolean mastery,
                            String labelKey, String countsKey) {
        /** @param id the stable kebab-case id, as in the concept
         *  @param level the rung this criterion belongs to
         *  @param source where its evidence comes from
         *  @param surface for beacon and joined criteria: the surface id the face reports
         *  @param requires for joined criteria: the stream fact the session must also show
         *  @param mastery true when it completes the badge but gates nothing
         *  @param labelKey i18n key of the short label
         *  @param countsKey i18n key of the "what counts" line */
        public Criterion {
            requireKey(id, "criterion id");
            Objects.requireNonNull(source, "source of " + id);
            requireKey(labelKey, "labelKey of " + id);
            requireKey(countsKey, "countsKey of " + id);
            if ((source == Source.BEACON || source == Source.JOINED)
                    && (surface == null || surface.isBlank())) {
                throw new IllegalArgumentException(id + " arrives as a beacon and must name its surface");
            }
        }
    }

    private static void requireKey(String value, String what) {
        if (value == null || value.isBlank()) {
            throw new IllegalArgumentException("levels.json: missing " + what);
        }
    }

    /** The parsed file, exactly as it sits on the classpath. */
    @JsonIgnoreProperties(ignoreUnknown = true)
    private record Document(int schemaVersion, List<Level> levels, List<Criterion> criteria) {}

    private static final class Holder {
        private static final Ladder BUNDLED = load();
    }

    private final int schemaVersion;
    private final List<Level> levels;
    private final List<Criterion> criteria;
    private final Map<String, Criterion> byId;

    private Ladder(Document doc) {
        this.schemaVersion = doc.schemaVersion();
        this.levels = List.copyOf(Objects.requireNonNull(doc.levels(), "levels"));
        this.criteria = List.copyOf(Objects.requireNonNull(doc.criteria(), "criteria"));
        Map<String, Criterion> index = new LinkedHashMap<>();
        for (Criterion c : this.criteria) {
            if (index.put(c.id(), c) != null) {
                throw new IllegalArgumentException("levels.json: duplicate criterion " + c.id());
            }
        }
        this.byId = Map.copyOf(index);
    }

    /**
     * The ladder shipped inside this jar, parsed once and shared.
     *
     * @return the bundled ladder, never null
     * @throws UncheckedIOException when the resource is missing or unparsable — that is a
     *         build defect, not a runtime condition, so it fails loudly rather than degrading
     */
    public static Ladder bundled() {
        return Holder.BUNDLED;
    }

    private static Ladder load() {
        try (InputStream in = Ladder.class.getResourceAsStream(RESOURCE)) {
            if (in == null) {
                throw new IOException("resource " + RESOURCE + " is not on the classpath");
            }
            String text = new String(in.readAllBytes(), StandardCharsets.UTF_8);
            return new Ladder(JSON.readValue(text, Document.class));
        } catch (IOException broken) {
            throw new UncheckedIOException("the bundled ladder could not be read", broken);
        }
    }

    /** @return the schema version of the loaded document */
    public int schemaVersion() {
        return schemaVersion;
    }

    /** @return the seven rungs, in ladder order */
    public List<Level> levels() {
        return levels;
    }

    /** @return every criterion, gating and mastery alike */
    public List<Criterion> criteria() {
        return criteria;
    }

    /**
     * @param id the criterion id
     * @return the criterion, or null when the id is unknown
     */
    public Criterion criterion(String id) {
        return byId.get(id);
    }

    /**
     * The rung an operator stands on: walk up while every advance criterion of the
     * current rung is marked. Mastery criteria never move anyone.
     *
     * @param marked the criterion ids marked so far
     * @return the level index, 0 to the last rung
     */
    public int levelFor(java.util.Set<String> marked) {
        Objects.requireNonNull(marked, "marked");
        int level = 0;
        for (Level rung : levels) {
            if (rung.advanceWhen().isEmpty() || !marked.containsAll(rung.advanceWhen())) {
                return level;
            }
            level = Math.min(rung.index() + 1, levels.size() - 1);
        }
        return level;
    }
}
