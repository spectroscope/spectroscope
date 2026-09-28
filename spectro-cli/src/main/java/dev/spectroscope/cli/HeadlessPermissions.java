package dev.spectroscope.cli;

import dev.spectroscope.core.config.SpectroConfig;

/**
 * What a {@code --permissions} value means for a headless run: whether gated
 * calls are approved, and whether the file tools may reach outside the
 * working directory (card 453). Shared by {@code spectro run} and
 * {@code spectro node}.
 */
final class HeadlessPermissions {

    private HeadlessPermissions() { }

    /** @param permissions the accepted flag value
     *  @return true when every gated call is approved without asking */
    static boolean approves(String permissions) {
        return "auto".equals(permissions)
                || SpectroConfig.PERMISSION_MODE_EXTENDED.equals(permissions);
    }

    /** @param permissions the accepted flag value
     *  @return true when the file tools may leave the working directory */
    static boolean reachesOutside(String permissions) {
        return SpectroConfig.PERMISSION_MODE_EXTENDED.equals(permissions);
    }
}
