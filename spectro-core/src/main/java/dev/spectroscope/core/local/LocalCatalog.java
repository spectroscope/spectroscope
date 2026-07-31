package dev.spectroscope.core.local;

import com.fasterxml.jackson.annotation.JsonIgnoreProperties;
import com.fasterxml.jackson.databind.ObjectMapper;

import java.io.IOException;
import java.io.InputStream;
import java.io.UncheckedIOException;
import java.nio.charset.StandardCharsets;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Objects;

/**
 * Which models the built-in provider can run, loaded from
 * {@code /local/models.json} in this module's resources. One file feeds the
 * chooser in the download dialog, the download endpoint's pinned url and
 * sha256, the runtime's context budget, the capability profile the agent loop
 * reads and the generated docs, so those copies cannot drift apart.
 *
 * <p>Nothing here ships weights. Every entry is a pointer to a public download
 * the operator starts, which is also what keeps the licences the operator's
 * business rather than ours (kanban card 102).</p>
 *
 * <p>The catalogue carries no prose: entries name i18n keys and the faces
 * resolve them, the same contract the ladder uses.</p>
 */
public final class LocalCatalog {

    private static final ObjectMapper JSON = new ObjectMapper();
    private static final String RESOURCE = "/local/models.json";

    /**
     * One downloadable model, with everything a fetch and a run both need.
     *
     * <p>{@code minRamBytes} is recommended TOTAL system memory rather than the
     * process's resident size: roughly twice the weights plus two gigabytes for
     * the operating system and the app, because a machine that has exactly the
     * weights free starts swapping the moment anything else wants memory.</p>
     *
     * @param id            stable kebab-case id, also the picker's model name
     * @param label         the human name, not translated (it is a proper noun)
     * @param file          the GGUF's name on disk under {@code ~/.spectro/models}
     * @param url           the public download, pinned to a single revision path
     * @param sha256        the expected digest, verified after the stream
     * @param sizeBytes     the exact download size, for the progress bar and the disk check
     * @param minRamBytes   recommended total system memory, see above
     * @param contextTokens the context window llama-server is started with
     * @param nativeTools   whether the model speaks the OpenAI {@code tool_calls} protocol
     * @param reasoning     whether it is reasoning-tuned and emits a think channel
     * @param licence       the SPDX-ish id the model page states
     * @param licenceUrl    where that statement can be read
     * @param sourceUrl     the repository the download comes from
     * @param blurbKey      i18n key of the one-line description
     * @param goodForKey    i18n key of the "use it for" line
     * @param licenceCaveatKey i18n key of a licence warning, or null when there is none
     */
    @JsonIgnoreProperties(ignoreUnknown = true)
    public record Model(String id, String label, String file, String url, String sha256,
                        long sizeBytes, long minRamBytes, int contextTokens,
                        boolean nativeTools, boolean reasoning,
                        String licence, String licenceUrl, String sourceUrl,
                        String blurbKey, String goodForKey, String licenceCaveatKey) {

        /** Validates the entry loudly: a broken catalogue is a build defect. */
        public Model {
            require(id, "model id");
            require(label, "label of " + id);
            require(file, "file of " + id);
            require(url, "url of " + id);
            require(sha256, "sha256 of " + id);
            require(licence, "licence of " + id);
            require(sourceUrl, "sourceUrl of " + id);
            require(blurbKey, "blurbKey of " + id);
            require(goodForKey, "goodForKey of " + id);
            if (sizeBytes <= 0 || minRamBytes <= 0 || contextTokens <= 0) {
                throw new IllegalArgumentException("models.json: " + id + " has a non-positive size, memory or context");
            }
        }

        /** @return the capability profile the agent loop reads for this model */
        public ModelProfile profile() {
            return new ModelProfile(nativeTools, reasoning);
        }
    }

    private static void require(String value, String what) {
        if (value == null || value.isBlank()) {
            throw new IllegalArgumentException("models.json: missing " + what);
        }
    }

    /** The parsed file, exactly as it sits on the classpath. */
    @JsonIgnoreProperties(ignoreUnknown = true)
    private record Document(int schemaVersion, String defaultId, List<Model> models) {}

    private static final class Holder {
        private static final LocalCatalog BUNDLED = load();
    }

    private final int schemaVersion;
    private final String defaultId;
    private final List<Model> models;
    private final Map<String, Model> byId;

    private LocalCatalog(Document doc) {
        this.schemaVersion = doc.schemaVersion();
        this.defaultId = Objects.requireNonNull(doc.defaultId(), "defaultId");
        this.models = List.copyOf(Objects.requireNonNull(doc.models(), "models"));
        Map<String, Model> index = new LinkedHashMap<>();
        for (Model m : this.models) {
            if (index.put(m.id(), m) != null) {
                throw new IllegalArgumentException("models.json: duplicate model " + m.id());
            }
        }
        this.byId = Map.copyOf(index);
        if (!this.byId.containsKey(this.defaultId)) {
            throw new IllegalArgumentException("models.json: defaultId " + this.defaultId + " is not in the list");
        }
    }

    /**
     * The catalogue shipped inside this jar, parsed once and shared.
     *
     * @return the bundled catalogue, never null
     * @throws UncheckedIOException when the resource is missing or unparsable, which is a
     *         build defect rather than a runtime condition, so it fails loudly
     */
    public static LocalCatalog bundled() {
        return Holder.BUNDLED;
    }

    private static LocalCatalog load() {
        try (InputStream in = LocalCatalog.class.getResourceAsStream(RESOURCE)) {
            if (in == null) {
                throw new IOException("resource " + RESOURCE + " is not on the classpath");
            }
            String text = new String(in.readAllBytes(), StandardCharsets.UTF_8);
            return new LocalCatalog(JSON.readValue(text, Document.class));
        } catch (IOException broken) {
            throw new UncheckedIOException("the bundled model catalogue could not be read", broken);
        }
    }

    /** @return the schema version of the loaded document */
    public int schemaVersion() {
        return schemaVersion;
    }

    /** @return the id of the model a fresh home offers first */
    public String defaultId() {
        return defaultId;
    }

    /** @return the model the default id names, never null */
    public Model defaultModel() {
        return byId.get(defaultId);
    }

    /** @return every model, in catalogue order (smallest first) */
    public List<Model> models() {
        return models;
    }

    /**
     * @param id the model id
     * @return the model, or null when the id is unknown
     * @throws IllegalArgumentException when the id is null or blank, which is a caller bug
     *         rather than an unknown model
     */
    public Model byId(String id) {
        if (id == null || id.isBlank()) {
            throw new IllegalArgumentException("model id must not be blank");
        }
        return byId.get(id);
    }

    /**
     * The model an operator has selected, falling back to the default when the
     * stored id names something this build no longer offers.
     *
     * @param selectedId the id from settings, may be null or stale
     * @return a model that exists, never null
     */
    public Model resolve(String selectedId) {
        if (selectedId == null || selectedId.isBlank()) {
            return defaultModel();
        }
        Model found = byId.get(selectedId);
        return found != null ? found : defaultModel();
    }
}
