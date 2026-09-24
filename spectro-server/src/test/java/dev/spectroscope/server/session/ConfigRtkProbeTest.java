package dev.spectroscope.server.session;

import org.junit.jupiter.api.Test;

import java.util.Map;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * Card 379, criterion 11, server half: {@code /api/config} tells the popover
 * whether rtk resolves and which version answered. The version is the string
 * the binary printed, so the probe is fed a version no release carries.
 */
class ConfigRtkProbeTest {

    @Test
    void theVersionIsPassedThroughAsTheBinaryPrintedIt() {
        Map<String, Object> probe = SessionsController.rtkProbe(() -> "rtk 9.9.9-probe");

        assertThat(probe).containsEntry("available", true);
        assertThat(probe).containsEntry("version", "rtk 9.9.9-probe");
    }

    @Test
    void aMissingRtkIsReportedAsMissingAndNotHidden() {
        Map<String, Object> probe = SessionsController.rtkProbe(() -> null);

        assertThat(probe).containsEntry("available", false);
        assertThat(probe).containsEntry("version", "");
    }

    @Test
    @SuppressWarnings("unchecked")
    void theConfigEndpointCarriesTheProbe() {
        Map<String, Object> config = new SessionsController().config();

        assertThat(config).containsKey("rtk");
        Map<String, Object> rtk = (Map<String, Object>) config.get("rtk");
        assertThat(rtk.get("available")).isInstanceOf(Boolean.class);
        assertThat(rtk.get("version")).isInstanceOf(String.class);
    }
}
