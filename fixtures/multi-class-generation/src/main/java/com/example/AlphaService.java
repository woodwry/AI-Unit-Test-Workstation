package com.example;

public class AlphaService {
    public String classify(int value) {
        return value > 0 ? "positive" : "non-positive";
    }
}
