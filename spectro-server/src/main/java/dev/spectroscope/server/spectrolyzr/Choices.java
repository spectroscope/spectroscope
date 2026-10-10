package dev.spectroscope.server.spectrolyzr;

import java.util.List;

/** What a person picked in the wizard. The order of {@code addons} carries no meaning. */
public record Choices(String archetype, String language, List<String> addons, String name) {}
