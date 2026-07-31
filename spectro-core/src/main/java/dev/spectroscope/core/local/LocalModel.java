package dev.spectroscope.core.local;

import java.nio.file.Path;

/**
 * The bundled model's identity and where it lives — the single source shared by
 * the server's provider status, the download dialog and the runtime launcher.
 * This build ships VibeThinker-3B (a Q4_K_M GGUF, ~2 GB); the "built-in ·
 * &lt;model&gt;" naming keeps it swappable later.
 */
public final class LocalModel {

    private LocalModel() {
    }

    /** The provider id and picker/runtime model name. */
    public static final String MODEL_ID = "vibethinker-3b";

    /** The GGUF file name (bundle or download target). */
    public static final String FILE = "vibethinker-3b-Q4_K_M.gguf";

    /** The user models dir — {@code ~/.spectro/models}, home of a downloaded
     *  model (and the STT model). */
    public static Path userModelsDir() {
        return Path.of(System.getProperty("user.home"), ".spectro", "models");
    }

    /** The bundled model dir on a "with model" DMG, or {@code null} on a lean
     *  build — the desktop app sets {@code spectro.bundle.models} to the packaged
     *  resources dir. */
    public static Path bundleDir() {
        String bundled = System.getProperty("spectro.bundle.models");
        return bundled == null || bundled.isBlank() ? null : Path.of(bundled);
    }

    /** Whether the model resolves in the real locations. */
    public static boolean present() {
        return presentIn(bundleDir(), userModelsDir());
    }

    /**
     * Whether the model resolves under the given roots — the seam the tests use.
     *
     * @param bundleDir     the app bundle model dir, or {@code null}
     * @param userModelsDir the user models dir
     * @return true when the GGUF is in the bundle or the user dir
     */
    public static boolean presentIn(Path bundleDir, Path userModelsDir) {
        return ModelResolution.locate(bundleDir, userModelsDir, FILE).source()
                != ModelResolution.Source.ABSENT;
    }

    /** Whether ANY catalogue model resolves in the real locations — the
     *  provider-status question since the chooser: the built-in provider is
     *  usable as soon as one model is on disk, whichever one that is. */
    public static boolean anyPresent() {
        return anyPresentIn(bundleDir(), userModelsDir());
    }

    /**
     * The same question under given roots — the seam the tests use.
     *
     * @param bundleDir     the app bundle model dir, or {@code null}
     * @param userModelsDir the user models dir
     * @return true when at least one catalogue model's GGUF resolves
     */
    public static boolean anyPresentIn(Path bundleDir, Path userModelsDir) {
        for (LocalCatalog.Model m : LocalCatalog.bundled().models()) {
            if (ModelResolution.locate(bundleDir, userModelsDir, m.file()).source()
                    != ModelResolution.Source.ABSENT) {
                return true;
            }
        }
        return false;
    }
}
