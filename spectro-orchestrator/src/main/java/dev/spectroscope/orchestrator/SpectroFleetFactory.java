package dev.spectroscope.orchestrator;

import dev.spectroscope.FleetPanel;
import dev.spectroscope.FleetPanelFactory;

/**
 * The ServiceLoader bridge: with spectro-orchestrator on the classpath,
 * {@code Spectro.panel()} resolves to this factory and the frozen facade
 * gains its fleet path — spectro-core itself never looks this way.
 */
public final class SpectroFleetFactory implements FleetPanelFactory {

    @Override
    public FleetPanel create() {
        return new OrchestratorPanel();
    }
}
