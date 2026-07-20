package dev.spectroscope.core.provider;

import java.util.concurrent.atomic.AtomicReference;

/**
 * An {@link LlmProvider} whose real implementation can be swapped at runtime.
 * The agent (and its subagents) are built ONCE per connection with the provider
 * baked in; wrapping the real provider in this indirection lets the web UI switch
 * the LLM backend mid-session — the swap takes effect on the NEXT run, the agent
 * instance (and its multi-turn history) is untouched. Same indirection pattern the
 * image provider uses; the stream call reads the current delegate every time.
 */
public final class SwitchableProvider implements LlmProvider {

    private final AtomicReference<LlmProvider> delegate;
    private final AtomicReference<String> name;

    /**
     * Starts with the boot-time provider; later {@link #swap} calls replace it.
     *
     * @param initial the provider active until the first swap
     * @param name    its label for {@code run_start} (e.g. "anthropic")
     */
    public SwitchableProvider(LlmProvider initial, String name) {
        this.delegate = new AtomicReference<>(initial);
        this.name = new AtomicReference<>(name);
    }

    /**
     * Point at a new provider (+ its label). Takes effect on the next stream call.
     *
     * @param provider     the new delegate every future stream call goes through
     * @param providerName its label for {@code run_start}
     */
    public void swap(LlmProvider provider, String providerName) {
        this.delegate.set(provider);
        this.name.set(providerName);
    }

    /**
     * Streams through whichever delegate is current at call time — a swap mid-run
     * does not touch an already-open stream.
     *
     * @param request the neutral request, passed through unchanged
     * @return the current delegate's event stream
     */
    @Override
    public Iterable<ProviderEvent> stream(ProviderRequest request) {
        return delegate.get().stream(request);
    }

    /**
     * The label of the currently selected provider — keeps {@code run_start}
     * truthful after a mid-session switch.
     *
     * @return the current provider label
     */
    @Override
    public String providerName() {
        return name.get();
    }
}
