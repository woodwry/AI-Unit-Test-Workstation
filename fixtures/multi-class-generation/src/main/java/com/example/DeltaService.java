package com.example;

public class DeltaService {
    public boolean available(boolean enabled, int stock) {
        return enabled && stock > 0;
    }
}
