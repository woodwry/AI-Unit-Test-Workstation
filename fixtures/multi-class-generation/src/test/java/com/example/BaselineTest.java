package com.example;

import org.junit.jupiter.api.Test;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

class BaselineTest {
    @Test
    void providesPartialCoverageForEveryFixtureClass() {
        assertEquals("non-positive", new AlphaService().classify(0));
        assertEquals("empty", new BetaService().normalize(null));
        assertEquals(5, new GammaService().maximum(5, 2));
        assertTrue(new DeltaService().available(true, 1));
        assertFalse(new DeltaService().available(false, 1));
        assertEquals(4, new EpsilonService().divide(8, 2));
    }
}
