package dev.spectroscope.core.config;

import dev.spectroscope.core.AgentOptions;
import dev.spectroscope.core.session.CareParagraph;
import dev.spectroscope.core.subagents.SubagentConfig;
import org.junit.jupiter.api.Test;

import java.lang.reflect.Constructor;
import java.lang.reflect.RecordComponent;
import java.util.Arrays;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertNull;

/**
 * Cards 490 and 492 each append one component to three public records. An
 * embedder or an SDK that called the canonical constructor of v0.14.4 keeps
 * compiling through one compat constructor per record with exactly that
 * arity, and gets no session count and the care paragraph off. The v0.14.4 arities are typed here (45, 25, 18, read
 * from the records at {@code 8d7fcf48}); the parameter types are the
 * current canonical ones without the two new components at the end.
 */
class V0144ArityCompatTest {

    private static final int NEW_COMPONENTS = 2;

    private static Object[] nulls(Class<?>[] types) {
        Object[] args = new Object[types.length];
        for (int i = 0; i < types.length; i++) {
            if (types[i] == boolean.class) {
                args[i] = false;
            } else if (types[i] == int.class) {
                args[i] = 0;
            } else if (types[i] == long.class) {
                args[i] = 0L;
            }
        }
        return args;
    }

    private static Object buildAtV0144Arity(Class<?> record, int v0144Arity) throws Exception {
        RecordComponent[] components = record.getRecordComponents();
        assertEquals(v0144Arity + NEW_COMPONENTS, components.length,
                record.getSimpleName() + ": premise, v0.14.4's arity plus sessionsPerChat and careParagraph");
        assertEquals("sessionsPerChat", components[components.length - 2].getName());
        assertEquals("careParagraph", components[components.length - 1].getName());
        Class<?>[] old = Arrays.stream(components).limit(v0144Arity)
                .map(RecordComponent::getType).toArray(Class<?>[]::new);
        Constructor<?> compat = record.getConstructor(old);
        assertNotNull(compat);
        return compat.newInstance(nulls(old));
    }

    private static Object component(Object instance, String name) throws Exception {
        return instance.getClass().getMethod(name).invoke(instance);
    }

    @Test
    void spectroConfigKeepsItsV0144Arity() throws Exception {
        Object built = buildAtV0144Arity(SpectroConfig.class, 45);
        assertNull(component(built, "sessionsPerChat"));
        assertFalse(CareParagraph.enabled((String) component(built, "careParagraph")),
                "the paragraph ships off");
    }

    @Test
    void agentOptionsKeepsItsV0144Arity() throws Exception {
        Object built = buildAtV0144Arity(AgentOptions.class, 25);
        assertNull(component(built, "sessionsPerChat"));
        assertFalse(CareParagraph.enabled((String) component(built, "careParagraph")),
                "the paragraph ships off");
    }

    @Test
    void subagentConfigKeepsItsV0144Arity() throws Exception {
        Object built = buildAtV0144Arity(SubagentConfig.class, 18);
        assertNull(component(built, "sessionsPerChat"));
        assertFalse(CareParagraph.enabled((String) component(built, "careParagraph")),
                "the paragraph ships off");
    }
}
