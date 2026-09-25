package com.example;

public class BetaService {
    public String normalize(String value) {
        return value == null || value.isBlank() ? "empty" : value.trim();
    }
}
