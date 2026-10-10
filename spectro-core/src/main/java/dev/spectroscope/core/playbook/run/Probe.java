package dev.spectroscope.core.playbook.run;

import java.util.List;

/**
 * One provider as the P1 registry last read it, copied so core does not
 * depend on the server's row type.
 */
public record Probe(String provider, String kind, String state, String endpoint, String reason,
                    List<String> models, boolean live, long checkedAt) {

    public Probe {
        models = models == null ? List.of() : List.copyOf(models);
    }

    /** @return true when the last check answered; the built in runtime counts when it is configured */
    public boolean answers() {
        return "reachable".equals(state) || ("builtin".equals(kind) && "configured".equals(state));
    }

    /**
     * @param model the model a step wants
     * @return true when the provider answers and, if its list is live, lists the model
     */
    public boolean serves(String model) {
        return answers() && (!live || models.contains(model));
    }
}
