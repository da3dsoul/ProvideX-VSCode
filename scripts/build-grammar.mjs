// Generates syntaxes/providex.tmLanguage.json from data/lexicon.json (the ProvideX lexer table).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const lex = JSON.parse(fs.readFileSync(path.join(root, 'data', 'lexicon.json'), 'utf8'));
let docs = {};
try { docs = JSON.parse(fs.readFileSync(path.join(root, 'data', 'docs', 'functions.json'), 'utf8')); } catch { /* optional */ }
let sysdocs = {};
try { sysdocs = JSON.parse(fs.readFileSync(path.join(root, 'data', 'docs', 'sysvars.json'), 'utf8')); } catch { /* optional */ }

const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const alt = (arr) => [...new Set(arr)].sort((a, b) => b.length - a.length || a.localeCompare(b)).map(esc).join('|');

const CONTROL = ['IF', 'THEN', 'ELSE', 'END_IF', 'FI', 'GOTO', 'GOSUB', 'RETURN', 'FOR', 'TO', 'STEP', 'NEXT', 'WHILE', 'WEND', 'REPEAT', 'UNTIL',
  'SWITCH', 'CASE', 'DEFAULT', 'BREAK', 'CONTINUE', 'EXIT', 'EXITTO', 'END', 'STOP', 'TRY', 'CATCH', 'FINALLY', 'END_TRY', 'ON', 'RETRY',
  'ESCAPE', 'QUIT', 'BYE', 'RUN', 'CALL', 'PERFORM', 'ENTER', 'EXECUTE', 'SETERR', 'SETESC', 'WAIT', 'PROCESS'];
const OOP = ['DEF', 'CLASS', 'ENDDEF', 'LIKE', 'PROPERTY', 'FUNCTION', 'LOCAL', 'CREATE', 'REQUIRED', 'OBJECT', 'GET', 'SET', 'PROGRAM', 'STATIC', 'DROP'];
const OPERATOR_WORDS = ['AND', 'OR', 'NOT'];
const directives = lex.directives.filter((d) => /^[A-Z_]+$/.test(d));
const others = directives.filter((d) => !CONTROL.includes(d) && !OOP.includes(d) && !OPERATOR_WORDS.includes(d));
const functions = [...new Set([...lex.functions, ...Object.keys(docs)])].filter((f) => /^[A-Z_][A-Z0-9_]*$/.test(f));
const sysvars = [...new Set([...lex.systemVariables, ...Object.keys(sysdocs).filter((s) => /^[A-Z_]+$/.test(s))])];
const options = [...new Set([...lex.fileOptions, 'IOL', 'LEN'])];
const W = '(?![A-Za-z0-9_$%.])';

const grammar = {
  $schema: 'https://raw.githubusercontent.com/martinring/tmlanguage/master/tmlanguage.json',
  name: 'ProvideX',
  scopeName: 'source.providex',
  fileTypes: ['pvx', 'pvt', 'pvxsrc', 'bbx', 'pxs'],
  patterns: [
    { include: '#line-start' },
    { include: '#statement' },
  ],
  repository: {
    'line-start': {
      patterns: [
        {
          // statement number, optional '?' error marker, optional label
          match: '^(\\s*)(\\d+)(\\??)(?=\\s|$)(?:(\\s+)([A-Za-z_][A-Za-z0-9_.]*)(:)(?!=))?',
          captures: { 2: { name: 'constant.numeric.line-number.providex' }, 3: { name: 'invalid.illegal.syntax-error.providex' }, 5: { name: 'entity.name.label.providex' }, 6: { name: 'punctuation.separator.label.providex' } },
        },
        {
          match: '^(\\s*)([A-Za-z_][A-Za-z0-9_.]*)(:)(?!=)',
          captures: { 2: { name: 'entity.name.label.providex' }, 3: { name: 'punctuation.separator.label.providex' } },
        },
      ],
    },
    statement: {
      patterns: [
        { include: '#comment' },
        { include: '#string' },
        { include: '#hex-string' },
        { include: '#rem' },
        { include: '#mnemonic' },
        { include: '#member' },
        { include: '#special' },
        { include: '#option' },
        { include: '#def-fn' },
        { include: '#user-function' },
        { include: '#function' },
        { include: '#control' },
        { include: '#oop' },
        { include: '#operator-word' },
        { include: '#directive' },
        { include: '#sysvar' },
        { include: '#branch-target' },
        { include: '#number' },
        { include: '#global-variable' },
        { include: '#string-variable' },
        { include: '#variable' },
        { include: '#operator' },
        { include: '#punctuation' },
      ],
    },
    comment: { match: '!.*$', name: 'comment.line.exclamation.providex' },
    rem: { match: `(?i)(?<![A-Za-z0-9_$%.'])(REM)${W}(.*)$`, captures: { 1: { name: 'keyword.other.rem.providex' }, 2: { name: 'comment.line.rem.providex' } } },
    string: {
      begin: '"', end: '"(?!")|$', name: 'string.quoted.double.providex',
      patterns: [{ match: '""', name: 'constant.character.escape.providex' }],
    },
    'hex-string': { match: '\\$[0-9A-Fa-f]*\\$', name: 'constant.other.hex-string.providex' },
    mnemonic: { match: "(?<![A-Za-z0-9_$%)\\]])'[^'\"\\s=,;()]{0,12}'", name: 'constant.other.mnemonic.providex' },
    member: {
      patterns: [
        { match: "(?<=[A-Za-z0-9_$%)\\]])'([A-Za-z_][A-Za-z0-9_.]*[$%]?)(?=\\s*\\()", captures: { 1: { name: 'entity.name.function.member.providex' } } },
        { match: "(?<=[A-Za-z0-9_$%)\\]])'([A-Za-z_][A-Za-z0-9_.]*[$%]?)", captures: { 1: { name: 'variable.other.property.providex' } } },
      ],
    },
    special: { match: '(?i)\\*(NEXT|SAME|RETRY|BREAK|CONTINUE|PROCEED|RETURN|END|ESCAPE|ALL)\\b', name: 'constant.language.special-target.providex' },
    option: { match: `(?i)(?<=[,(])\\s*(${alt(options)})\\s*(?==)`, captures: { 1: { name: 'keyword.other.option.providex' } } },
    'def-fn': { match: `(?i)\\b(DEF)\\s+(FN%?[A-Za-z_][A-Za-z0-9_.]*[$%]?)`, captures: { 1: { name: 'storage.type.function.providex' }, 2: { name: 'entity.name.function.providex' } } },
    'user-function': { match: `(?i)\\bFN%?[A-Za-z_][A-Za-z0-9_.]*[$%]?(?=\\s*\\()`, name: 'entity.name.function.user.providex' },
    function: { match: `(?i)\\b(${alt(functions)})(?=\\s*\\()`, name: 'support.function.builtin.providex' },
    control: { match: `(?i)\\b(${alt(CONTROL)})${W}`, name: 'keyword.control.providex' },
    oop: { match: `(?i)\\b(${alt(OOP)})${W}`, name: 'storage.type.providex' },
    'operator-word': { match: `(?i)\\b(${alt(OPERATOR_WORDS)})${W}`, name: 'keyword.operator.logical.providex' },
    directive: { match: `(?i)\\b(${alt(others)})${W}`, name: 'keyword.other.directive.providex' },
    sysvar: { match: `(?i)\\b(${alt([...sysvars, '_OBJ', '_PARENT'])})${W}(?!\\s*\\()`, name: 'variable.language.system.providex' },
    'branch-target': { match: '(?i)(?<=\\b(?:GOTO|GOSUB|EXITTO|SETERR|SETESC)\\s)\\s*([A-Za-z_][A-Za-z0-9_.]*)(?![$%])', captures: { 1: { name: 'entity.name.label.reference.providex' } } },
    number: { match: '(?<![A-Za-z_$%])(?:\\d+\\.?\\d*|\\.\\d+)(?:[eE][+-]?\\d+)?', name: 'constant.numeric.providex' },
    'global-variable': { match: '%[A-Za-z_][A-Za-z0-9_.]*[$%]?', name: 'variable.other.global.providex' },
    'string-variable': { match: '\\b[A-Za-z_][A-Za-z0-9_.]*\\$', name: 'variable.other.string.providex' },
    variable: { match: '\\b[A-Za-z_][A-Za-z0-9_.]*%?', name: 'variable.other.providex' },
    operator: { match: '\\*\\*|<=|>=|<>|=<|=>|><|\\+=|-=|\\*=|/=|\\^=|\\+\\+|--|[-+*/^=<>|&@?]', name: 'keyword.operator.providex' },
    punctuation: {
      patterns: [
        { match: ';', name: 'punctuation.terminator.statement.providex' },
        { match: ',', name: 'punctuation.separator.providex' },
        { match: '[{}]', name: 'punctuation.section.block.providex' },
        { match: '[()\\[\\]]', name: 'punctuation.section.brackets.providex' },
        { match: ':', name: 'punctuation.separator.colon.providex' },
      ],
    },
  },
};

// ---------------------------------------------------------------- ProvideX/TS (.pxts)
const TS_KEYWORDS = ['if', 'else', 'for', 'to', 'step', 'while', 'repeat', 'until', 'switch', 'case', 'default', 'break', 'continue', 'return', 'goto', 'gosub', 'exitto', 'try', 'catch', 'finally', 'select', 'from', 'where', 'begin', 'end'];
const TS_DECL = ['function', 'let', 'const', 'class', 'extends', 'public', 'private', 'readonly', 'constructor', 'destructor', 'method', 'property', 'local', 'like', 'def'];
const pxts = {
  $schema: 'https://raw.githubusercontent.com/martinring/tmlanguage/master/tmlanguage.json',
  name: 'ProvideX/TS',
  scopeName: 'source.pxts',
  fileTypes: ['pxts'],
  patterns: [{ include: '#statement' }],
  repository: {
    statement: {
      patterns: [
        { include: '#comment' }, { include: '#raw' }, { include: '#mnemonic-tag' }, { include: '#string' }, { include: '#single-string' }, { include: '#decorator' },
        { include: '#function-decl' }, { include: '#class-decl' }, { include: '#label' }, { include: '#member' },
        { include: '#special' }, { include: '#accessor' }, { include: '#new' }, { include: '#extends' }, { include: '#keyword' }, { include: '#decl' }, { include: '#this' }, { include: '#builtin' },
        { include: '#call' }, { include: '#sysvar' }, { include: '#number' }, { include: '#global-variable' },
        { include: '#string-variable' }, { include: '#variable' }, { include: '#operator' }, { include: '#punctuation' },
      ],
    },
    comment: { match: '//.*$', name: 'comment.line.double-slash.pxts' },
    // raw ProvideX is one line: matched as a whole, so ProvideX comments/strings inside cannot run past the closing backtick
    raw: {
      patterns: [
        {
          match: '(pvx)(`)([^`]*)(`)',
          captures: { 1: { name: 'support.function.raw.pxts' }, 2: { name: 'punctuation.definition.raw.pxts' }, 3: { name: 'meta.embedded.providex', patterns: [{ include: 'source.providex#statement' }] }, 4: { name: 'punctuation.definition.raw.pxts' } },
        },
        {
          match: '(pvx)(`)(.*)$',
          captures: { 1: { name: 'support.function.raw.pxts' }, 2: { name: 'punctuation.definition.raw.pxts' }, 3: { name: 'meta.embedded.providex', patterns: [{ include: 'source.providex#statement' }] } },
        },
      ],
    },
    string: {
      begin: '"', end: '"|$', name: 'string.quoted.double.pxts',
      patterns: [{ match: '\\\\(x[0-9A-Fa-f]{2}|.)', name: 'constant.character.escape.pxts' }],
    },
    'function-decl': { match: '\\b(function|def)\\s+([A-Za-z_%][A-Za-z0-9_]*[$%]?)', captures: { 1: { name: 'storage.type.function.pxts' }, 2: { name: 'entity.name.function.pxts' } } },
    'class-decl': { match: '\\b(class)\\s+([A-Za-z_][A-Za-z0-9_]*)', captures: { 1: { name: 'storage.type.class.pxts' }, 2: { name: 'entity.name.type.class.pxts' } } },
    label: { match: '^\\s*([A-Za-z_][A-Za-z0-9_]*)(:)(?!:)\\s*(//.*)?$', captures: { 1: { name: 'entity.name.label.pxts' }, 3: { name: 'comment.line.double-slash.pxts' } } },
    member: {
      patterns: [
        { match: '(?<=[A-Za-z0-9_$%)\\]])\\.([A-Za-z_][A-Za-z0-9_]*(?:::[A-Za-z0-9_]+)*[$%]?)(?=\\s*\\()', captures: { 1: { name: 'entity.name.function.member.pxts' } } },
        { match: '(?<=[A-Za-z0-9_$%)\\]])\\.([A-Za-z_][A-Za-z0-9_]*(?:::[A-Za-z0-9_]+)*[$%]?)', captures: { 1: { name: 'variable.other.property.pxts' } } },
      ],
    },
    special: { match: '(?i)\\*(NEXT|SAME|RETRY|BREAK|CONTINUE|PROCEED|RETURN|END|ESCAPE)\\b', name: 'constant.language.special-target.pxts' },
    // get X() / set X(v) in a class (elsewhere get/set are ordinary names)
    accessor: { match: '\\b(get|set)\\s+(?=[A-Za-z_][A-Za-z0-9_]*[$%]?\\s*\\()', captures: { 1: { name: 'storage.type.accessor.pxts' } } },
    // new Cls(...) creates an object; new(expr, ...) is the ProvideX NEW() function
    new: { patterns: [{ match: '\\b(new)\\s+([A-Za-z_][A-Za-z0-9_]*)', captures: { 1: { name: 'keyword.operator.new.pxts' }, 2: { name: 'entity.name.type.class.pxts' } } }, { match: '\\bnew(?=\\s*\\()', name: 'support.function.builtin.pxts' }] },
    extends: { begin: '\\b(extends)\\b', end: '(?=\\{)|$', beginCaptures: { 1: { name: 'storage.modifier.extends.pxts' } }, patterns: [{ match: '[A-Za-z_][A-Za-z0-9_]*', name: 'entity.other.inherited-class.pxts' }, { include: '#string' }, { match: ',', name: 'punctuation.separator.pxts' }] },
    keyword: { match: `\\b(${alt(TS_KEYWORDS)})\\b(?![$%])`, name: 'keyword.control.pxts' },
    decl: { match: `\\b(${alt(TS_DECL)})\\b(?![$%])`, name: 'storage.type.pxts' },
    this: { match: '\\b(this|global)\\b', name: 'variable.language.this.pxts' },
    decorator: { match: '(@)([A-Za-z_][A-Za-z0-9_]*)', captures: { 1: { name: 'punctuation.decorator.pxts' }, 2: { name: 'entity.name.function.decorator.pxts' } } },
    'mnemonic-tag': { match: '\\b(m)(`)([^`]*)(`)', captures: { 1: { name: 'support.function.mnemonic.pxts' }, 3: { name: 'constant.other.mnemonic.pxts' } } },
    'single-string': { begin: "'", end: "'|$", name: 'string.quoted.single.pxts', patterns: [{ match: '\\\\(x[0-9A-Fa-f]{2}|.)', name: 'constant.character.escape.pxts' }] },
    builtin: { match: `(?i)\\b(${alt(functions)})(?=\\s*\\()`, name: 'support.function.builtin.pxts' },
    call: { match: '\\b([A-Za-z_][A-Za-z0-9_]*[$%]?)(?=\\s*\\()', captures: { 1: { name: 'entity.name.function.pxts' } } },
    sysvar: { match: `\\b(${alt(sysvars)})\\b(?![$%(])`, name: 'variable.language.system.pxts' },
    number: { match: '(?<![A-Za-z_$%])(?:\\d+\\.?\\d*|\\.\\d+)(?:[eE][+-]?\\d+)?', name: 'constant.numeric.pxts' },
    'global-variable': { match: '%[A-Za-z_][A-Za-z0-9_]*(?:::[A-Za-z0-9_]+)*[$%]?', name: 'variable.other.global.pxts' },
    'string-variable': { match: '\\b[A-Za-z_][A-Za-z0-9_]*(?:::[A-Za-z0-9_]+)*\\$', name: 'variable.other.string.pxts' },
    variable: { match: '\\b[A-Za-z_][A-Za-z0-9_]*(?:::[A-Za-z0-9_]+)*%?', name: 'variable.other.pxts' },
    operator: { match: '===|!==|==|!=|<=|>=|&&|\\|\\||\\*\\*|\\+=|-=|\\*=|/=|\\+\\+|--|=>|[-+*/<>=!@]', name: 'keyword.operator.pxts' },
    punctuation: { patterns: [{ match: ';', name: 'punctuation.terminator.statement.pxts' }, { match: ',', name: 'punctuation.separator.pxts' }, { match: '[{}]', name: 'punctuation.section.block.pxts' }, { match: '[()\\[\\]]', name: 'punctuation.section.brackets.pxts' }] },
  },
};

fs.mkdirSync(path.join(root, 'syntaxes'), { recursive: true });
// raw pvx`...` text is highlighted with a copy of the ProvideX rules (capture patterns cannot reach another grammar)
const prefixIncludes = (o) => JSON.parse(JSON.stringify(o, (k, v) => (k === 'include' && typeof v === 'string' && v.startsWith('#') ? '#pvx_' + v.slice(1) : v)));
for (const [k, v] of Object.entries(grammar.repository)) pxts.repository['pvx_' + k] = prefixIncludes(v);
const rawJson = JSON.stringify(pxts.repository.raw).split('source.providex#statement').join('#pvx_statement');
pxts.repository.raw = JSON.parse(rawJson);
fs.writeFileSync(path.join(root, 'syntaxes', 'pxts.tmLanguage.json'), JSON.stringify(pxts, null, 2));
fs.writeFileSync(path.join(root, 'syntaxes', 'providex.tmLanguage.json'), JSON.stringify(grammar, null, 2));
console.log(`grammar: ${functions.length} functions, ${directives.length} directives, ${sysvars.length} system variables`);
