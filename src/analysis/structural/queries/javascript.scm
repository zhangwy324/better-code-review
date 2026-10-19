; Declarations in JavaScript. TypeScript and TSX run this file followed by typescript.scm, so
; every node type here must exist in all three grammars.
; Conventions (see ../README.md): `@definition.<kind>` captures the declaration, `@name` its
; name, and `(#set! test "true")` marks a test. When several patterns capture the same
; declaration, the earliest pattern sets the kind, so specific patterns come first.

(import_statement
  source: (string (string_fragment) @name)) @definition.import

(class_declaration
  name: (_) @name) @definition.class

(method_definition
  name: (property_identifier) @name
  (#eq? @name "constructor")) @definition.constructor

(method_definition
  name: (_) @name) @definition.method

(function_declaration
  name: (identifier) @name) @definition.function

(generator_function_declaration
  name: (identifier) @name) @definition.function

; `const f = () => …`, `let g = function () {…}`
(variable_declarator
  name: (identifier) @name
  value: [(arrow_function) (function_expression) (generator_function)]) @definition.function

; Test blocks: `describe('…', …)`, `it('…', …)`, `test.only('…', …)`. The name is the title.
((call_expression
  function: [
    (identifier) @_fn
    (member_expression object: (identifier) @_fn)
  ]
  arguments: (arguments . (string (string_fragment) @name)))
  @definition.function
  (#any-of? @_fn "describe" "it" "test")
  (#set! test "true"))
