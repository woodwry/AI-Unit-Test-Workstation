import type * as Monaco from 'monaco-editor';
import { ThemeSettingDefaults } from '@codingame/monaco-vscode-api/vscode/vs/workbench/services/themes/common/workbenchThemeService';
import { runMonacoStage } from './monaco-initialization-diagnostics.ts';

// Codingame 的 Workbench 主题服务不支持 standalone 的 defineTheme，默认使用其内置深色主题。
export const DEFAULT_EDITOR_THEME = ThemeSettingDefaults.COLOR_THEME_DARK;

export const JAVA_MODIFIERS = [
  'abstract', 'default', 'final', 'native', 'non-sealed', 'private', 'protected',
  'public', 'sealed', 'static', 'strictfp', 'synchronized', 'transient', 'volatile'
] as const;

export const JAVA_KEYWORDS = [
  'assert', 'break', 'case', 'catch', 'class', 'const', 'continue', 'do', 'else',
  'enum', 'exports', 'extends', 'finally', 'for', 'goto', 'if', 'implements',
  'import', 'instanceof', 'interface', 'module', 'new', 'open', 'opens', 'package',
  'permits', 'provides', 'record', 'requires', 'return', 'super', 'switch',
  'this', 'throw', 'throws', 'to', 'transitive', 'try', 'uses', 'when', 'while',
  'with', 'yield'
] as const;

export const JAVA_TYPE_KEYWORDS = [
  'boolean', 'byte', 'char', 'double', 'float', 'int', 'long', 'short', 'var', 'void'
] as const;

const WORKSTATION_JAVA_LANGUAGE: Monaco.languages.IMonarchLanguage = {
  defaultToken: '',
  tokenPostfix: '.java',
  modifiers: [...JAVA_MODIFIERS],
  keywords: [...JAVA_KEYWORDS, 'false', 'null', 'true'],
  typeKeywords: [...JAVA_TYPE_KEYWORDS],
  operators: [
    '=', '>', '<', '!', '~', '?', ':', '==', '<=', '>=', '!=', '&&', '||',
    '++', '--', '+', '-', '*', '/', '&', '|', '^', '%', '<<', '>>', '>>>',
    '+=', '-=', '*=', '/=', '&=', '|=', '^=', '%=', '<<=', '>>=', '>>>=',
    '->', '::'
  ],
  symbols: /[=><!~?:&|+\-*/^%]+/,
  escapes: /\\(?:[btnfr"'\\]|[0-3][0-7]{0,2}|[4-7][0-7]?|u[0-9a-fA-F]{4})/,
  tokenizer: {
    root: [
      [/non-sealed\b/, 'keyword.modifier'],
      [/@[A-Za-z_$][\w$]*/, 'annotation'],
      [/[A-Z_$][\w$]*/, 'type.identifier'],
      [/[a-zA-Z_$][\w$]*/, {
        cases: {
          '@modifiers': 'keyword.modifier',
          '@typeKeywords': 'keyword.type',
          '@keywords': 'keyword',
          '@default': 'identifier'
        }
      }],
      { include: '@whitespace' },
      [/[{}()\[\]]/, '@brackets'],
      [/[<>](?!@symbols)/, '@brackets'],
      [/@symbols/, { cases: { '@operators': 'operator', '@default': '' } }],
      [/0[xX][0-9a-fA-F](?:_?[0-9a-fA-F])*[lL]?/, 'number.hex'],
      [/0[bB][01](?:_?[01])*[lL]?/, 'number.binary'],
      [/\d(?:_?\d)*\.\d(?:_?\d)*(?:[eE][+-]?\d(?:_?\d)*)?[fFdD]?/, 'number.float'],
      [/\d(?:_?\d)*(?:[eE][+-]?\d(?:_?\d)*)[fFdD]?/, 'number.float'],
      [/\d(?:_?\d)*[fFdDlL]?/, 'number'],
      [/[;,.]/, 'delimiter'],
      [/"""/, 'string', '@textBlockString'],
      [/"/, 'string', '@string'],
      [/'(?:[^'\\]|\\.)'/, 'string'],
      [/'/, 'string.invalid']
    ],
    whitespace: [
      [/[ \t\r\n]+/, ''],
      [/\/\*\*/, 'comment.doc', '@docComment'],
      [/\/\*/, 'comment', '@comment'],
      [/\/\/.*$/, 'comment']
    ],
    comment: [
      [/[^/*]+/, 'comment'],
      [/\*\//, 'comment', '@pop'],
      [/[/*]/, 'comment']
    ],
    docComment: [
      [/[^/*]+/, 'comment.doc'],
      [/\*\//, 'comment.doc', '@pop'],
      [/[/*]/, 'comment.doc']
    ],
    string: [
      [/[^\\"]+/, 'string'],
      [/@escapes/, 'string.escape'],
      [/\\./, 'string.escape.invalid'],
      [/"/, 'string', '@pop']
    ],
    textBlockString: [
      [/[^\\"]+/, 'string'],
      [/@escapes/, 'string.escape'],
      [/\\./, 'string.escape.invalid'],
      [/"""/, 'string', '@pop'],
      [/"/, 'string']
    ]
  }
};

const WORKSTATION_JAVA_CONFIGURATION: Monaco.languages.LanguageConfiguration = {
  comments: { lineComment: '//', blockComment: ['/*', '*/'] },
  brackets: [
    ['{', '}'],
    ['[', ']'],
    ['(', ')']
  ],
  autoClosingPairs: [
    { open: '{', close: '}' },
    { open: '[', close: ']' },
    { open: '(', close: ')' },
    { open: '"', close: '"', notIn: ['string'] },
    { open: "'", close: "'", notIn: ['string', 'comment'] }
  ],
  surroundingPairs: [
    { open: '{', close: '}' },
    { open: '[', close: ']' },
    { open: '(', close: ')' },
    { open: '"', close: '"' },
    { open: "'", close: "'" }
  ]
};

let workstationMonacoConfigured = false;

export function configureWorkstationMonaco(monaco: typeof Monaco): void {
  if (workstationMonacoConfigured) {
    return;
  }

  runMonacoStage('java-language-registration', () => {
    if (!monaco.languages.getLanguages().some((language) => language.id === 'java')) {
      monaco.languages.register({ id: 'java', aliases: ['Java'], extensions: ['.java'] });
    }
  });
  runMonacoStage('java-configuration', () =>
    monaco.languages.setLanguageConfiguration('java', WORKSTATION_JAVA_CONFIGURATION)
  );
  runMonacoStage('java-tokenizer', () =>
    monaco.languages.setMonarchTokensProvider('java', WORKSTATION_JAVA_LANGUAGE)
  );
  workstationMonacoConfigured = true;
}
