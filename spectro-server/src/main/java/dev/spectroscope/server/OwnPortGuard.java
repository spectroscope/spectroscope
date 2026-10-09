package dev.spectroscope.server;

import dev.spectroscope.core.tools.HostGuard;
import dev.spectroscope.server.web.OwnPort;
import org.springframework.boot.web.context.WebServerInitializedEvent;
import org.springframework.context.ApplicationListener;
import org.springframework.stereotype.Component;

/**
 * Card 396: tells the host guard which port this server listens on, so an
 * agent's {@code lsof -ti :PORT | xargs kill} on it is refused. Card 472: and
 * tells the browser fence, which lets the app's own code graph view through on
 * this port ({@link OwnPort}). The port is known only once the web server has
 * bound, which is when this event fires.
 */
@Component
class OwnPortGuard implements ApplicationListener<WebServerInitializedEvent> {

    /**
     * Records the bound port.
     *
     * @param event the web server that just started
     */
    @Override
    public void onApplicationEvent(WebServerInitializedEvent event) {
        HostGuard.protectPort(event.getWebServer().getPort());
        OwnPort.set(event.getWebServer().getPort());
    }
}
