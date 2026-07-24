package dev.spectroscope.core.local;

import java.nio.file.Files;
import java.nio.file.Path;

/**
 * Locate the bundled GGUF: the app bundle wins (the "with model" DMG), then the
 * user models dir (a lean DMG that has downloaded it), else ABSENT — with the
 * path a download should fill. Pure beyond existence checks, so the two DMG
 * variants share exactly one resolution rule.
 */
public final class ModelResolution {

    private ModelResolution() {
    }

    /** Where the model came from — drives the picker status and the download modal. */
    public enum Source { BUNDLE, USER_DIR, ABSENT }

    /**
     * A located model.
     *
     * @param path   the file path; for {@link Source#ABSENT} it is the intended
     *               download target under the user models dir
     * @param source where it was found (or ABSENT)
     */
    public record Resolved(Path path, Source source) {}

    /**
     * Resolve the model file.
     *
     * @param bundleDir      the app bundle's model dir, or {@code null} on a lean build
     * @param userModelsDir  {@code ~/.spectro/models}
     * @param fileName       the GGUF file name
     * @return the located model, or ABSENT pointing at the download target
     */
    public static Resolved locate(Path bundleDir, Path userModelsDir, String fileName) {
        if (bundleDir != null) {
            Path inBundle = bundleDir.resolve(fileName);
            if (Files.isRegularFile(inBundle)) {
                return new Resolved(inBundle, Source.BUNDLE);
            }
        }
        Path inUser = userModelsDir.resolve(fileName);
        if (Files.isRegularFile(inUser)) {
            return new Resolved(inUser, Source.USER_DIR);
        }
        return new Resolved(inUser, Source.ABSENT);
    }
}
