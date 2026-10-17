# Sage ProvideX for Visual Studio Code

Language support for **Sage ProvideX** (the Business BASIC behind Sage 100 / MAS 90 / MAS 200), built as a VS Code extension plus a language server, with optional integration with an installed ProvideX to **decompile, compile, syntax-check and run** programs.

> This is a community project. It is not made, endorsed or supported by Sage. Sage, Sage 100 and ProvideX are trademarks of The Sage Group plc or its licensors. The extension contains no Sage software. Its ProvideX features use the ProvideX you already have installed and licensed.

## Features

| Area | What you get |
| --- | --- |
| Syntax highlighting | TextMate grammar generated from ProvideX's own lexer table. It covers statement numbers, labels, directives, functions, system variables, mnemonics (`'CS'`), object members (`obj'Method()`), I/O options (`ERR=`, `KEY=`, …), special targets (`*NEXT`), hex strings (`$0D0A$`), comments (`!`, `REM`). Semantic highlighting from the language server refines it. |
| Diagnostics | Built-in analyzer: undefined labels (Error #55), duplicate labels (Error #56), references to missing statement numbers, unbalanced `FOR/NEXT`, `WHILE/WEND`, `REPEAT/UNTIL`, `SWITCH/END SWITCH`, `TRY/END_TRY`, `SELECT/NEXT RECORD`, `{ }`, `DEF CLASS/END DEF`, unterminated strings, built-in function argument counts. **Plus the real ProvideX compiler** (on save, or as you type) through the installed ProvideX. |
| Completion | Directives, functions (with parameter snippets), system variables, variables, `DEF FN` functions, labels and statement numbers after `GOTO`/`GOSUB`/`ERR=`/…, special targets, I/O options inside channel lists, mnemonics, `SET_PARAM` parameters, class names in `NEW("…")` / `LIKE "…"`, program names in `CALL`/`PERFORM`/`RUN`, and **object members** (`obj'`), including inherited (`LIKE`) members of Sage 100 classes, which are decompiled on demand. |
| Hover | Signatures and descriptions for built-in functions, directives, system variables, I/O options, mnemonics, system parameters and error numbers (`IF ERR=11`). Also labels, statement numbers, variables (first assignment), `DEF FN`, class members and classes. |
| Signature help | Built-in functions, `DEF FN`, class methods. |
| Navigation | Go to definition / implementation (method declaration → implementing label), references, document highlight, rename (labels, variables, `DEF FN`, class members across the workspace), document & workspace symbols, call hierarchy over `GOSUB`/labels, code lens reference counts, document links for `CALL "prog;ENTRY"` / `PERFORM` / `RUN`. |
| Editing | Formatting (keyword case, optional block indentation, trailing whitespace), folding (blocks, label sections, comment runs), snippets, quick fixes (create missing label, similar-label suggestions), bracket / quote auto-closing, comment toggling. |
| ProvideX integration | Open a compiled program (`.pvc`, `.pvo`, `.m4p`, or any `[Pvxprg]` file) **as source**. Saving compiles it back (a `.bak` is written first). Compile text sources, check syntax, run a program in `pvxwin32.exe`, evaluate an expression, renumber or strip statement numbers. |

## Requirements

* VS Code 1.85+.
* For ProvideX integration: Windows, with ProvideX installed (Sage 100 installs it). The extension drives the installed interpreter through its `ProvideX.Script` COM automation server (`pvxcom.exe`) via a small PowerShell bridge (`bridge/pvxbridge.ps1`). Nothing extra needs installing.

The home folder (the folder containing `pvxwin32.exe` and `Lib`, e.g. `C:\Sage\Sage 100\MAS90\Home`) is auto-detected from the workspace and the usual install locations. Set `providex.home` to override.

## Readable view of compiled programs

Compiled programs open in a readable form (`providex.compiledView`: `readable`, the default, or `numbered` for raw `LIST` output). It smooths over ProvideX's quirks, and each of these rewrites was checked against the real ProvideX 9.62 compiler. The checks covered ~2,000 Sage programs plus runtime-equivalence tests.

| ProvideX quirk | Readable view | Why it is safe |
| --- | --- | --- |
| Every statement has a number (`0010`, `0020`, …) and jumps target numbers | Numbers are hidden. Jump targets become labels (an existing label is reused, otherwise `L0100:`). `GOTO 0100`, `ERR=0100`, `ON x GOTO 0100,0200` all jump to labels. | Labels are first-class jump targets. On save, unchanged statements get their **original numbers** back. New statements are numbered into the gaps, and only a few neighbours are renumbered when there's no room. |
| Jumps to a number that doesn't exist go to the next statement | The jump is pointed at the label of the statement that actually runs | Verified at runtime |
| Several statements per line (`A=1; B=2`) | One statement per line | Same execution order |
| `IF c THEN a; b ELSE d; e` on one line, where everything after `THEN` is conditional | `IF c THEN { a / b } ELSE { d / e }` blocks | Verified at runtime: `;` after `THEN` is conditional, and `ELSE` applies to the whole `THEN` part |
| `LIST` inserts `LET` in every assignment | `LET` hidden (`readable.omitLet`) | ProvideX re-inserts it on compile |
| No indentation or spacing is stored; keywords are upper-cased | Blocks indented, operators spaced | ProvideX discards whitespace and keyword case (format → compile → `LIST` is identical) |
| Variable case | Kept | The bridge compiles with `SET_PARAM 'MC'`, as Sage does. Without it, ProvideX upper-cases every variable name. |

`ProvideX: Make Readable` applies the same transformation to a text source. Format Document applies the spacing, indentation and keyword case (`providex.format.*`).

## ProvideX/TS (`.pxts`)

A TypeScript-style syntax for ProvideX. It is a **lossless** re-skin: every `.pxts` file translates to ProvideX, which is what gets compiled and run, and back again. The ProvideX language server serves `.pxts` files through a token-level position map, so all the language features above work there too.

```ts
@create(required)                          // DEF CLASS "AR_MyCustomer" CREATE REQUIRED
class AR_MyCustomer extends SY_Maint {     // LIKE "SY_Maint"
  @get(GET_BALANCE) readonly Balance;      // PROPERTY Balance GET GET_BALANCE SET ERR
  private coSession;                       // LOCAL coSession

  constructor(coSession) {                 // ON_CREATE: / ENTER coSession
    return;
  }

  Recalc(force?) {                         // FUNCTION Recalc(force)RECALC ... RECALC: / ENTER force,ERR=*NEXT
    if (this.GetColumnInfo("AR_Customer", "Balance").Length > 0 && !force) {
      return retSUCCESS;
    }
    for (i = 1; i <= 10; i++) total += i;
    read({ ch: cCh, key: k$, err: *NEXT }, rec$);   // READ (cCh,KEY=k$,ERR=*NEXT)rec$
    o = new SY_Thing(coSession);                    // NEW("SY_Thing",coSession)
    pvx`PRINT 'CS','BR',@(0,0),"raw ProvideX"`;     // anything else, verbatim
    return retSUCCESS;
  }
}

function repeat$(s$, n) {          // DEF FN with real local scope (LOCAL), see below
  let out$ = "", i
  for (i = 1; i <= n; i++) out$ += s$
  return out$
}

const FNTAX = (A) => A * 0.07;     // DEF FNTAX(A)=A*0.07
```

| ProvideX | ProvideX/TS |
| --- | --- |
| `obj'Method()'Prop`, `_OBJ'x`, `%Global` | `obj.Method().Prop`, `this.x`, `global.Global` |
| `rec.Field$` (dotted names) | `rec::Field$` |
| `=` (comparison), `<>`, `AND`, `OR`, `NOT(x)`, `^` | `==`, `!=`, `&&`, `||`, `!x`, `**` |
| `!` comments | `//` comments |
| `"a""b"`, `$0D0A$`, `'CS'` (mnemonic) | `"a\"b"`, `"\x0D\x0A"`, `` m`CS` `` |
| `IF c THEN { } ELSE { }`, `WHILE/WEND`, `REPEAT/UNTIL`, `SELECT/NEXT RECORD`, `TRY/CATCH/FINALLY/END_TRY` | `if (c) { } else { }`, `while (c) { }`, `repeat { } until (c)`, `select ... { }`, `try { } catch { } finally { }` |
| `FOR I=1 TO N` / `STEP 2` / `STEP -1` | `for (I = 1; I <= N; I++)` / `I += 2` / `I >= 1; I--` |
| `SWITCH X` / `CASE 1,2` / `DEFAULT` | `switch (X) { case 1: case 2: default: }` |
| `READ (1,KEY=K$,ERR=*NEXT)A$`, `CLOSE (F)`, `DROP OBJECT X,ERR=*NEXT` | `read({ ch: 1, key: K$, err: *NEXT }, A$)`, `close({ ch: F })`, `dropObject(X, { err: *NEXT })` |
| `X'Open(A$,ERR=*NEXT)`, `NEW("Cls",A)` | `X.Open(A$, { err: *NEXT })`, `new Cls(A)` |
| `DEF FNX(A)=expr` | `const FNX = (A) => expr;` |
| `DEF CLASS "X" CREATE REQUIRED` / `LIKE "A"` / `END DEF` | `@create(required) class X extends A { }` |
| `PROPERTY P`, `PROPERTY P GET G SET ERR`, `LOCAL x` | `public P;`, `@get(G) readonly P;`, `private x;` |
| `FUNCTION M(a$)M_LABEL` + `M_LABEL: ENTER a$ ... RETURN` | `M(a$) { ... }` inside the class (the label is the method name in UPPER_SNAKE, or `@label(X)`) |
| `FUNCTION LOCAL M()`, `FUNCTION PERFORM M()`, `FUNCTION M(x)=expr`, overloads | `private M()`, `@perform M()`, `M(x) { return expr; }`, `M(); M(a$); M(a$?) { }` |
| `ON_CREATE:` / `ON_DELETE:` / property `GET`/`SET` labels | `constructor()` / `destructor()` / `get P()` / `set P(v)` |
| Unbalanced or GOTO-entered loops, unknown syntax | `` pvx`...` `` (verbatim) |

**Classes keep their layout.** A ProvideX class is a header (`DEF CLASS` … `END DEF`) followed by `LABEL:` sections. In ProvideX/TS the methods sit inside the class, so the header and the sections are regenerated when you save. When you save over an existing program, declarations and comments that only moved go back to where the program had them, and so do equivalent spellings such as `IF (x) THEN` vs `IF x THEN`. Saving an unchanged file therefore leaves the program unchanged. A class keeps the ProvideX layout when its methods are implemented outside its region.

**Functions with local scope.** ProvideX `DEF FN` parameters are *global* (calling `FNX(5)` overwrites a caller's `X`), and `RETURN` is not allowed inside a loop. `function` lowers to a pattern that was verified against ProvideX 9.62. Parameters are passed under mangled names (`px_name.arg`) and copied into `LOCAL` variables, which are saved per call, so recursion works. Every `let` becomes a `LOCAL`. A `return` inside loops sets a flag and `BREAK`s out level by level. The generated lines carry `! @pxts` tags, so they fold back into the `function` form. Limits: `LOCAL` arrays are not allowed, and `DEF FN` recursion is capped at roughly 100 levels by ProvideX.

Commands: **Convert to ProvideX/TS (.pxts)**, **Convert ProvideX/TS to ProvideX**, **Open Compiled Program as ProvideX/TS** (or set `providex.compiledView` to `typescript`). **Compile** and **Run** work on `.pxts` files directly.

Verification: every program in the ~2,000-program Sage corpus was translated readable → `.pxts` → ProvideX and compiled. ProvideX's own listing has to be identical to the readable form's, apart from equivalent spellings such as `""`/`$$`. Runtime tests confirm the function semantics (recursion, locals, return from nested loops and from `switch`).

## ProvideX licences

Decompiling, compiling and ProvideX syntax checking all need ProvideX to list and edit programs. ProvideX only allows that with a **development** activation. An install activated as runtime-only (the end-user licence that ships with a typical Sage 100 install) refuses with Error #61 "Authorization failure". The licence is checked by ProvideX itself, against the activation in its `Lib\Keys` folder (set up with `pvxwactv.exe`). The extension cannot and does not change that.

At startup the extension tries every ProvideX install it finds and uses one with a development licence. It prefers `providex.home`, then the install nearest the workspace. Which ProvideX does the work doesn't depend on where the program lives, so a development install can open another install's programs. If the preferred install is runtime-only, you're told which one is used instead. If none has a development licence, the status bar shows **ProvideX: runtime licence**, and every feature that doesn't need ProvideX keeps working. Click the status bar item (or run **ProvideX: Choose ProvideX Installation**) to see what each install reported and to pick another.

## File types

* Text sources: `.pvx`, `.pvt`, `.pvxsrc`, `.bbx`, `.pxs` (and `.txt` files that look like ProvideX). Statement numbers are optional. Numbered (`0010 PRINT …`) and lineless (label-based) code are both supported. Lineless sources are numbered automatically when compiled.
* Compiled programs (`[Pvxprg]` header) open through the `pvxprg:` file system, decompiled with ProvideX's own `LIST`.

## Commands

`ProvideX: Open Compiled Program as Source`, `Decompile Program to Text File`, `Compile Current File`, `Check Syntax with ProvideX`, `Run Program`, `Evaluate Expression`, `Renumber Statements`, `Toggle Statement Numbers`, `Show Status`, `Restart Language Server`.

## Settings

| Setting | Default | |
| --- | --- | --- |
| `providex.home` | auto | ProvideX home folder |
| `providex.executable` | `<home>\pvxwin32.exe` | Interpreter used by **Run Program** |
| `providex.runArguments` | `[]` | Extra arguments before the program name |
| `providex.bridge.enabled` | `true` | Use the installed ProvideX for checking/compiling/decompiling |
| `providex.diagnostics.useProvideX` | `onSave` | `off` / `onSave` / `onType` |
| `providex.diagnostics.undefinedLabels` / `unusedLabels` / `blockStructure` | `true` / `false` / `true` | Analyzer checks |
| `providex.format.keywordCase` | `upper` | `upper` / `lower` / `preserve` |
| `providex.format.indentBlocks`, `indentSize` | `false`, `2` | Indent block bodies (lineless sources) |
| `providex.compile.outputExtension`, `compile.onSave` | `.pvc`, `false` | Compiling text sources |
| `providex.decompile.lineNumbers` | `true` | Keep statement numbers when decompiling |
| `providex.classPath` | `[]` | Extra folders searched for compiled classes |

## How the language data was produced

The lexicon (`data/lexicon.json`: 195 directives, 126 functions, 46 system variables, mnemonics, I/O options, operators and aliases) was extracted from the ProvideX 9.62 lexer table `Lib/_lexdef.en`. The installed ProvideX read it via its COM server. Error texts (`data/errors.json`) come from `MSG(n)`, and system parameters (`data/params.json`) from `Lib/_prmdef.en`.

[REA](https://github.com/morluto/rea) (with Rizin) was used to inspect `pvxwin32.dll`. It showed that the interpreter carries no keyword strings of its own, which means the external lexer table is authoritative. That finding is why the tables above are taken from `_lexdef.en`. Descriptions and signatures (`data/docs/*.json`) were written separately, and their arities and return types were checked against the real ProvideX compiler (see `data/docs/VALIDATION.md`).

To regenerate the tables from your own ProvideX version:

```
set PVX_HOME=C:\Sage\Sage 100\MAS90\Home
npm run extract
```

## Development

```
npm install
npm run build          # bundle client + server into dist/
npm test               # unit, grammar and language-server tests (set PVX_HOME to include ProvideX bridge tests)
npm run test:vscode    # integration tests in an isolated VS Code (set VSCODE_EXECUTABLE to use an installed Code.exe)
npm run test:corpus -- <folder of .pvx files>   # analyzer false-positive report over a corpus
npm run package        # build a .vsix
```

`scripts/build-corpus.mjs` decompiles a folder of compiled programs into a local corpus for `test:corpus`. Never commit decompiled Sage code.

## Limitations

* ProvideX reports syntax errors per statement (Error #20), with no column. The whole statement is marked.
* There is no debugger integration: ProvideX has no debug-adapter interface. Use **Run Program** together with ProvideX's own `SETTRACE`/`ESCAPE` tooling.
* The COM bridge is Windows-only. On other platforms every language feature works except the ProvideX-backed ones.
