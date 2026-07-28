package dev.spectroscope.server;

import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.web.socket.config.annotation.EnableWebSocket;
import org.springframework.web.socket.config.annotation.WebSocketConfigurer;
import org.springframework.web.socket.config.annotation.WebSocketHandlerRegistry;
import org.springframework.web.socket.server.standard.ServletServerContainerFactoryBean;

/**
 * Registers the socket endpoints. {@code setAllowedOrigins("*")} only disables
 * Spring's own same-origin check (which would wrongly block the vite-proxy
 * origin); the real gate is an interceptor in both cases.
 *
 * <p>{@code /ws} — the agent socket — wears {@link LocalOriginHandshakeInterceptor}
 * (card 92): the same loopback + Host + Origin fence the REST endpoints wear,
 * port-agnostic, closing cross-site WebSocket hijacking.</p>
 *
 * <p>{@code /ws/shell} — the terminal socket (card 93) — wears
 * {@link ShellHandshakeInterceptor}, which is the same fence plus a required
 * Origin, refusing with 404 so the endpoint reads as absent, and absent for real
 * when there is no PTY helper or the operator set {@code SPECTRO_SHELL=off}.</p>
 */
@Configuration
@EnableWebSocket
public class WebSocketConfig implements WebSocketConfigurer {

    private final SpectroSocketHandler handler;

    /** The PTY seam and the shells it has open — one set per server process. */
    private final PtyProvider ptyProvider = new HelperPtyProvider();
    private final ShellRegistry shells = new ShellRegistry();

    /**
     * Spring wiring — receives the one handler instance shared by all connections.
     *
     * @param handler the socket handler that owns a SessionConnection per open socket
     */
    public WebSocketConfig(SpectroSocketHandler handler) {
        this.handler = handler;
    }

    /**
     * Maps the handlers: {@code /ws} for the agent, {@code /ws/shell} for a terminal.
     *
     * @param registry Spring's registry the mappings are added to
     */
    @Override
    public void registerWebSocketHandlers(WebSocketHandlerRegistry registry) {
        registry.addHandler(handler, "/ws")
                .addInterceptors(new LocalOriginHandshakeInterceptor())
                .setAllowedOrigins("*");
        registry.addHandler(new ShellSocketHandler(shells, ptyProvider), "/ws/shell")
                .addInterceptors(new ShellHandshakeInterceptor(
                        ptyProvider::available, Shells::enabled))
                .setAllowedOrigins("*");
    }

    /**
     * the servlet container's default text-message buffer is 8 KB — a
     * base64 image blows past it and the container closes the socket with status
     * 1009. file_upload raised it to 64 MB: since oversized images are now
     * DOWNSCALED server-side instead of rejected, a real iPhone photo (30+ MB
     * source, ~48 MB as base64) must reach the handler in the first place.
     *
     * <p>The binary buffer is raised for the shell socket: keystroke frames are
     * tiny, but a paste is one frame and the container default of 8 KiB would cut
     * it in half and close the connection.</p>
     *
     * @return the container tuning bean carrying the raised 64 MB text-message buffer
     */
    @Bean
    public ServletServerContainerFactoryBean webSocketContainer() {
        ServletServerContainerFactoryBean container = new ServletServerContainerFactoryBean();
        container.setMaxTextMessageBufferSize(64 * 1024 * 1024);
        container.setMaxBinaryMessageBufferSize(ShellFrame.MAX_DATA * 4);
        return container;
    }
}
