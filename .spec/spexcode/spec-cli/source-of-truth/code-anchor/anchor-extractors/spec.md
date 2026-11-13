---
title: anchor-extractors
status: active
hue: 15
desc: Language rows extract named units from source text with Tree-sitter WASM. TypeScript rows retry a grammar rejection with SpexCode's compiler. Unparseable files leave anchors unverified with an integrity error.
code:
  - packages/spec-core/src/anchors.ts#treeSitterExtractor
  - packages/spec-core/src/anchors.ts#treeSitterLanguage
  - packages/spec-core/src/anchors.ts#unitsAtFileRevision
  - packages/spec-core/src/anchors.ts#fileRevisionMemoKey
related:
  - spec-cli/src/anchors.test.ts
  - spec-cli/src/lint.ts
  - spec-cli/src/guide.ts
---

# anchor-extractors

Below [[code-anchor]]'s resolver sits the one place SpexCode reads source structure. A language enters as a row,
never as a resolver branch, and everything above the seam — memoization, dead/ambiguous resolution, hunk∩range —
stays language-agnostic.

**Extraction is a language seam.** Extractors are pure `(content, filename) → units` functions (no
git, no cache, no fs — importable by an external scorer as-is), and every extension maps to exactly
ONE designated extractor. Each language row carries its Tree-sitter grammar, extension set,
declaration-node rules, qualified-name rules, and extractor schema. Adding a language adds a row and
grammar asset. SpexCode supplies its parsing dependencies and initializes them lazily. An unavailable
runtime, missing grammar, or incompatible grammar ABI leaves the affected anchors unverified with an
explicit `integrity` error.

Every row rejects Tree-sitter's error-recovery tree. For `.ts`, `.mts`, `.cts`, and `.tsx`, the row
retries a syntax rejection with SpexCode's pinned TypeScript compiler, which parses the supplied text
with the file's script kind and produces units only when it reports zero parse diagnostics. This covers
valid syntax the shipped grammar can reject, such as `abstract?: string | null` in a type literal.
The compiler resolves from the tool's installation and runs only a syntax parse. It reads no project
configuration, resolves no candidate imports, and executes no candidate dependencies. The retry uses
the same declaration vocabulary, qualified-name matching, type-only flags, and one-based source ranges.
If parsing still fails, the `integrity` error names the file and parser verdict and leaves every anchor
in that file unverified.

The place to meet that cost is the ref-change gate, at the moment the construct is written, and the
population it must cover is EVERY declared selector. A selector's declaration site — a node's frontmatter
or a scenario's `code:` in an measurement contract — decides who repairs it, never whether it is checked: both write
`path#unit` and both arrive here. [[spec-lint]] owns that gate and refuses an unresolvable selector from
either site as one integrity error. A file no node anchors but many scenarios do was, before that, a file
this engine parsed constantly and no gate ever asked about.

The extractor contract stays language-agnostic above the seam: immutable file-revision memoization,
dead/ambiguous resolution, and hunk∩range all live outside it. A memo key includes every input to the
extractor: object-hash algorithm and blob oid, filename semantics (including script kind), extractor/schema
identity, grammar/runtime identity, the configured compiler retry identity and version, and normalized
query configuration. The same bytes under `.ts` and `.tsx`
therefore never share a result by oid alone, and the result is independent of call order. Within one READ
— a lint run, a board build, a CLI scan — every live anchored window is handed to the engine at once: it
reads a historical `(commit,path)` image, its blob, and an ordinary `(commit,path)` hunk once, then applies
each node's own selector set and emits findings in declaration order.

The Tree-sitter rows preserve one shared declaration vocabulary. TypeScript/TSX expose top-level functions,
classes and class methods, simple variable declarations, enums, interfaces, type aliases, and local
default exports. JS-family rows expose the direct `export default` statement as the module's
`default` unit, covering the full statement. The TypeScript syntax retry uses the same range and
marks a default-exported type as type-only. A named default declaration also retains its original
unit. Export lists, re-exports and TypeScript's `export =` do not create this unit. Python
exposes module-scope assignments that bind a value (including annotated, chained, and destructuring targets,
also when nested in module control-flow blocks), `def`, `async def`, and classes with lexical qualification;
imported names and function/class-local assignments remain outside the capability; Go exposes constants,
types, functions,
and receiver methods (`Command.SetArgs`); Rust exposes constants, structs, enums, traits, functions, and
impl methods (`Command.set_args`); Java exposes classes, final fields, constructors as `Class.constructor`,
and methods (so overloads remain ambiguous); and Ruby exposes constants, methods, singleton methods,
classes, and modules with enclosing class/module qualification. Decorators and declaration ranges come from
the syntax nodes. Dynamic
callables, imported aliases, macro-generated declarations, and runtime-attached methods remain outside the
capability. Unsupported names fail as dead anchors, and duplicate qualified declarations stay ambiguous
through the same language-agnostic resolver used by every extractor.
