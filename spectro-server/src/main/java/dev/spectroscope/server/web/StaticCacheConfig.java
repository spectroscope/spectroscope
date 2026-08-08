package dev.spectroscope.server.web;

import org.springframework.context.annotation.Configuration;
import org.springframework.http.CacheControl;
import org.springframework.web.servlet.config.annotation.ResourceHandlerRegistry;
import org.springframework.web.servlet.config.annotation.WebMvcConfigurer;

import java.util.concurrent.TimeUnit;

/**
 * The asset half of the split cache policy (card 130).
 *
 * <p>Everything Vite writes into {@code static/assets/} is content-hashed —
 * {@code index-*.js}, {@code index-*.css}, the woff2 fonts, the xterm chunks —
 * so a name never outlives its content and never needs revalidating. Those
 * files get {@code Cache-Control: max-age=31536000, public, immutable}.</p>
 *
 * <p>Everything else — {@code index.html}, {@code brand/}, {@code demo/} —
 * keeps a stable name across builds and answers {@code no-cache} via
 * {@code spring.web.resources.cache.cachecontrol.no-cache=true} in
 * application.properties. The entry document is the dangerous one: a cached
 * shell that skips revalidation asks for hashed assets a new jar no longer
 * contains, and the result is a blank window, not an old page.</p>
 *
 * <p>This handler registers the more specific {@code /assets/**} pattern, which
 * the resource handler mapping ranks above Boot's autoconfigured {@code /**} —
 * {@code StaticCacheHeadersTest} pins that precedence.</p>
 */
@Configuration
public class StaticCacheConfig implements WebMvcConfigurer {

    /** One year in seconds, the conventional ceiling for immutable content. */
    private static final long ONE_YEAR_SECONDS = 31_536_000L;

    @Override
    public void addResourceHandlers(ResourceHandlerRegistry registry) {
        registry.addResourceHandler("/assets/**")
                .addResourceLocations("classpath:/static/assets/")
                .setCacheControl(CacheControl.maxAge(ONE_YEAR_SECONDS, TimeUnit.SECONDS)
                        .cachePublic()
                        .immutable());
    }
}
