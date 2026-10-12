package dev.spectroscope.core.permission;

import org.junit.jupiter.api.Test;

import static org.junit.jupiter.api.Assertions.assertEquals;

/** Card 547: the shipped tier map rates {@code code_graph} as a reader. */
class CodeGraphTierTest {

    @Test
    void codeGraphResolvesToRead() {
        assertEquals(ToolTier.READ, ToolTierMap.shipped().resolve("code_graph").tier());
    }
}
