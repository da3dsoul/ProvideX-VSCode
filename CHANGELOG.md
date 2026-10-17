# Changelog

## 0.1.0

* TextMate grammars for ProvideX and ProvideX/TS, generated from the ProvideX 9.62 lexer table.
* Language server: diagnostics, completion, hover, signature help, definition/implementation, references, rename, symbols, folding, formatting, semantic tokens, code actions, call hierarchy, code lens and document links.
* ProvideX integration through the `ProvideX.Script` COM server: decompile, compile, check syntax, run and evaluate. On startup the extension checks every ProvideX install it finds and prefers one with a development licence; if none has one, it says so.
* Readable view of compiled programs:
  * statement numbers are hidden and jump targets become labels; numbers are restored on save, and unchanged statements keep their original ones;
  * one statement per line, and one-line `IF … ELSE` expanded into blocks;
  * `LET` hidden, indentation and spacing added.
* ProvideX/TS (`.pxts`): a lossless TypeScript-style syntax for ProvideX. It includes `function`s with real local scope, and the full language server works on it.
  * Classes read like TypeScript: `@create(required) class X extends A { public P; private x; constructor() { } M(a$?) { } }`. Method bodies (the `LABEL:` sections) sit inside the class, and the header is regenerated on save in the program's original order.
  * C-style `for (i = 1; i <= n; i++)`, `case 1: case 2:`, `const FNX = (A) => …`, `read({ ch: 1, key: k$ }, a$)`, `obj.Open(a$, { err: *NEXT })`, `new Cls(a)`, `global.X`, `` m`CS` `` mnemonics, `'…'` strings.
* Fixed: compiling now uses `SET_PARAM 'MC'`, as Sage does, so variable names keep their case.
