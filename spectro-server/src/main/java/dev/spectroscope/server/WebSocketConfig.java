package dev.spectroscope.server;

import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.web.socket.config.annotation.EnableWebSocket;
import org.springframework.web.socket.config.annotation.WebSocketConfigurer;
import org.springframework.web.socket.config.annotation.WebSocketHandlerRegistry;
import org.springframework.web.socket.server.standard.ServletServerContainerFactoryBean;

/**
 * Registers the single socket handler on /ws. {@code setAllowedOrigins("*")}
 * only disables Spring's own same-origin check (which would wrongly block the
 * vite-proxy origin); the real gate is {@link LocalOriginHandshakeInterceptor}
 * (card 92) — the same loopback + Host + Origin fence the REST endpoints wear,
 * port-agnostic, closing cross-site WebSocket hijacking.
 */
@Configuration
@EnableWebSocket
public class WebSocketConfig implements WebSocketConfigurer {

    private final SpectroSocketHandler handler;

    /**
     * Spring wiring — receives the one handler instance shared by all connections.
     *
     * @param handler the socket handler that owns a SessionConnection per open socket
     */
    public WebSocketConfig(SpectroSocketHandler handler) {
        this.handler = handler;
    }

    /**
     * Maps the handler onto {@code /ws} — the single socket endpoint the UI connects to.
     *
     * @param registry Spring's registry the /ws mapping is added to
     */
    @Override
    public void registerWebSocketHandlers(WebSocketHandlerRegistry registry) {
        registry.addHandler(handler, "/ws")
                .addInterceptors(new LocalOriginHandshakeInterceptor())
                .setAllowedOrigins("*");
    }

    /**
     * the servlet container's default text-message buffer is 8 KB — a
     * base64 image blows past it and the container closes the socket with status
     * 1009. file_upload raised it to 64 MB: since oversized images are now
     * DOWNSCALED server-side instead of rejected, a real iPhone photo (30+ MB
     * source, ~48 MB as base64) must reach the handler in the first place.
     *
     * @return the container tuning bean carrying the raised 64 MB text-message buffer
     */
    @Bean
    public ServletServerContainerFactoryBean webSocketContainer() {
        ServletServerContainerFactoryBean container = new ServletServerContainerFactoryBean();
        container.setMaxTextMessageBufferSize(64 * 1024 * 1024);
        return container;
    }
}
