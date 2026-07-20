package dev.spectroscope;

/**
 * ServiceLoader hook behind {@link Spectro#panel()}: the orchestrator module
 * registers its implementation under
 * {@code META-INF/services/dev.spectroscope.FleetPanelFactory}. Keeping the
 * lookup here lets the frozen facade own the entry point while spectro-core
 * never depends on the fleet module.
 */
public interface FleetPanelFactory {

    /** @return a fresh, unconfigured panel */
    FleetPanel create();
}
