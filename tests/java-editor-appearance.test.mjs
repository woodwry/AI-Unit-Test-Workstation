import assert from 'node:assert/strict';
import test from 'node:test';

import { collectJavaLocalSemanticTokens } from '../src/renderer/src/java-local-semantic-tokens.ts';
import {
  JAVA_KEYWORDS,
  JAVA_MODIFIERS,
  configureWorkstationMonaco
} from '../src/renderer/src/monaco-editor-appearance.ts';

function materializeTokens(source) {
  const lines = source.split(/\r?\n/);
  return collectJavaLocalSemanticTokens(source).map((token) => ({
    ...token,
    text: lines[token.lineNumber - 1].slice(token.startColumn - 1, token.endColumn - 1)
  }));
}

test('Java fallback distinguishes modifiers, keywords, types and declared variables', () => {
  const source = [
    'package com.example.demo;',
    'public class Demo {',
    '  private static final String reportName = "private class ignored";',
    '  void run(String input) {',
    '    int count = 1;',
    '    return;',
    '  }',
    '}'
  ].join('\n');
  const tokens = materializeTokens(source);

  for (const modifier of ['public', 'private', 'static', 'final']) {
    assert.ok(tokens.some((token) => token.text === modifier && token.token === 'modifier'));
  }
  for (const keyword of ['package', 'class', 'return']) {
    assert.ok(tokens.some((token) => token.text === keyword && token.token === 'keyword'));
  }
  for (const type of ['Demo', 'String', 'void', 'int']) {
    assert.ok(tokens.some((token) => token.text === type && token.token === 'type'));
  }
  for (const variable of ['reportName', 'input', 'count']) {
    assert.ok(tokens.some((token) => token.text === variable && token.token === 'variable'));
  }
});

test('Java fallback ignores keyword-like text inside comments, strings and text blocks', () => {
  const source = [
    'class Demo {',
    '  String text = "private static Fake ignored";',
    '  // public final String commentValue;',
    '  /* private final Long blockValue; */',
    '  String block = """',
    '    \\""" public class StillText { int escapedValue; }',
    '    public class Hidden { int value; }',
    '    """;',
    '}'
  ].join('\n');
  const tokens = materializeTokens(source);

  assert.equal(tokens.some((token) => token.lineNumber === 3), false);
  assert.equal(tokens.some((token) => token.lineNumber === 4), false);
  assert.equal(tokens.some((token) => token.lineNumber === 6), false);
  assert.equal(tokens.some((token) => token.lineNumber === 7), false);
  assert.equal(
    tokens.some((token) => token.lineNumber === 2 && ['private', 'static', 'Fake', 'ignored'].includes(token.text)),
    false
  );
});

test('bundled Java grammar catalog includes declarations and access modifiers', () => {
  for (const keyword of ['package', 'import', 'class', 'record', 'return']) {
    assert.ok(JAVA_KEYWORDS.includes(keyword));
  }
  for (const modifier of ['public', 'private', 'protected', 'static', 'final', 'sealed']) {
    assert.ok(JAVA_MODIFIERS.includes(modifier));
  }
});

test('配置本地 Java 语法时不调用 Workbench 主题服务不支持的 defineTheme', () => {
  const languageCalls = [];
  const monaco = {
    editor: {
      defineTheme() {
        throw new TypeError('standaloneThemeService.defineTheme is not a function');
      }
    },
    languages: {
      getLanguages: () => [],
      register: (language) => languageCalls.push(['register', language.id]),
      setLanguageConfiguration: (languageId) => languageCalls.push(['configuration', languageId]),
      setMonarchTokensProvider: (languageId) => languageCalls.push(['tokenizer', languageId])
    }
  };

  assert.doesNotThrow(() => configureWorkstationMonaco(monaco));
  assert.deepEqual(languageCalls, [
    ['register', 'java'],
    ['configuration', 'java'],
    ['tokenizer', 'java']
  ]);
});
