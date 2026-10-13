package dev.spectroscope.core;

import org.junit.jupiter.api.Test;

import java.lang.reflect.Constructor;
import java.util.Arrays;
import java.util.List;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNull;

/** Card 593: the switch that keeps the part texts off a helper's context_info. */
class AgentOptionsIntrospectionTextsTest {

    @Test
    void theBuilderCarriesTheSwitchAndLeavesItUnsetByDefault() {
        AgentOptions unset = AgentOptions.builder().provider(request -> List.of()).build();
        assertNull(unset.introspectionTexts(), "unset keeps the texts, as every caller before this card");

        AgentOptions off = AgentOptions.builder()
                .provider(request -> List.of())
                .introspection(true)
                .introspectionTexts(false)
                .build();
        assertEquals(Boolean.FALSE, off.introspectionTexts());
        assertEquals(Boolean.TRUE, off.introspection());
    }

    @Test
    void theCard503ArityStillBuildsAndKeepsTheTexts() throws Exception {
        Constructor<?> compat = Arrays.stream(AgentOptions.class.getConstructors())
                .filter(c -> c.getParameterCount() == 30)
                .findFirst()
                .orElseThrow(() -> new AssertionError("the 30-argument constructor of card 503 is gone"));
        Object[] args = new Object[30];
        args[29] = Boolean.FALSE; // agentMessaging, the last parameter
        AgentOptions built = (AgentOptions) compat.newInstance(args);
        assertNull(built.introspectionTexts(), "a caller of the older arity keeps the texts");
        assertEquals(Boolean.FALSE, built.agentMessaging(), "the caller's messaging switch arrives as passed");
        assertNull(built.peerReadOnSend(), "a caller of the arity before card 594 keeps the read at the turn start");
    }

    @Test
    void theCard594ArityStillBuildsAndKeepsTheTexts() throws Exception {
        Constructor<?> compat = Arrays.stream(AgentOptions.class.getConstructors())
                .filter(c -> c.getParameterCount() == 31)
                .findFirst()
                .orElseThrow(() -> new AssertionError("the 31-argument constructor of card 594 is gone"));
        Object[] args = new Object[31];
        args[29] = Boolean.FALSE; // agentMessaging
        args[30] = Boolean.TRUE; // peerReadOnSend, the last parameter
        AgentOptions built = (AgentOptions) compat.newInstance(args);
        assertNull(built.introspectionTexts(), "a caller of card 594's arity keeps the texts");
        assertEquals(Boolean.TRUE, built.peerReadOnSend(), "the caller's read switch arrives as passed");
        assertEquals(Boolean.FALSE, built.agentMessaging(), "the caller's messaging switch arrives as passed");
    }

    @Test
    void theArityBeforeCard503KeepsTheTextsToo() throws Exception {
        Constructor<?> compat = Arrays.stream(AgentOptions.class.getConstructors())
                .filter(c -> c.getParameterCount() == 29)
                .findFirst()
                .orElseThrow(() -> new AssertionError("the 29-argument constructor from before card 503 is gone"));
        AgentOptions built = (AgentOptions) compat.newInstance(new Object[29]);
        assertNull(built.introspectionTexts(), "a caller of the arity before card 503 keeps the texts");
    }
}
