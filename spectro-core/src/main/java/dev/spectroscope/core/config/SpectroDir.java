package dev.spectroscope.core.config;

import java.nio.file.Path;

/**
 * The name of spectroscope's own folder inside a project — spelled once
 * (card 350, criterion 6).
 *
 * <h2>What this is and is not</h2>
 *
 * <p>It is the <b>project-level</b> folder: the one that sits beside the code an
 * operator has checked out, carries {@code settings.json}, {@code skills/} and —
 * since card 350 — {@code launch.json}, and travels with the repository. It is
 * NOT the home-level {@code ~/.spectro}, which is a different thing that happens
 * to share a name: that one is this machine's private state (models, wires,
 * gate audits) and is reached through {@link SpectroConfig#CONFIG_PATH} and its
 * neighbours. On 2026-08-31 the main sources spelled {@code ".spectro"} in 36
 * places and <b>32 of them were the home-level folder</b>. Folding those in
 * would have made two unrelated decisions look like one, so they were left
 * alone: this constant holds the four project-level sites that existed, plus
 * the launch file card 350 adds.
 *
 * <h2>Why it exists at all</h2>
 *
 * <p>Card 350 puts another file in there, and one more hand-spelled literal is
 * the point at which "the next thing that needs a home invents a second
 * spelling" stops being hypothetical. The pin is in {@code SpectroDirDriftTest}: change the name
 * here and every project-level path moves with it, or the test says which one
 * did not.
 */
public final class SpectroDir {

    /** The folder's name, relative to a project root. */
    public static final String NAME = ".spectro";

    private SpectroDir() {
    }

    /**
     * One project-relative path inside the folder.
     *
     * <p>Forward slashes, because these are compared and printed as strings —
     * the callers resolve them against a {@link Path}, which accepts a
     * slash-separated relative path on every platform this ships to.
     *
     * @param relative the file or folder name inside {@code .spectro}
     * @return the project-relative path, e.g. {@code .spectro/settings.json}
     */
    public static String project(String relative) {
        return NAME + "/" + relative;
    }

    /**
     * The folder itself under one project root.
     *
     * @param projectRoot the folder the operator has open
     * @return {@code <projectRoot>/.spectro}
     */
    public static Path in(Path projectRoot) {
        return projectRoot.resolve(NAME);
    }
}
