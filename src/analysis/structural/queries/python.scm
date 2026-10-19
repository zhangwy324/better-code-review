; Declarations in Python.
; Conventions (see ../README.md): `@definition.<kind>` captures the declaration, `@name` its
; name, and `(#set! test "true")` marks a test. When several patterns capture the same
; declaration, the earliest pattern sets the kind, so specific patterns come first.
; Decorated definitions capture the inner `function_definition` / `class_definition`; the
; decorators are its previous siblings inside `decorated_definition`.

; `import a.b, c as d`: one declaration per module. The name is the module path.
(import_statement
  name: [
    (dotted_name) @name
    (aliased_import name: (dotted_name) @name)
  ]) @definition.import

; `from .a import b`: the name is the module, relative prefix included.
(import_from_statement
  module_name: (_) @name) @definition.import

(class_definition
  body: (block [
    (function_definition name: (identifier) @name) @definition.constructor
    (decorated_definition definition: (function_definition name: (identifier) @name) @definition.constructor)
  ])
  (#eq? @name "__init__"))

(class_definition
  body: (block [
    (function_definition name: (identifier) @name) @definition.method
    (decorated_definition definition: (function_definition name: (identifier) @name) @definition.method)
  ]))

(function_definition
  name: (identifier) @name) @definition.function

(class_definition
  name: (identifier) @name) @definition.class

; pytest conventions: `test*` functions and methods, `Test*` classes.
((function_definition
  name: (identifier) @name) @definition.function
  (#match? @name "^test")
  (#set! test "true"))

((class_definition
  name: (identifier) @name) @definition.class
  (#match? @name "^Test")
  (#set! test "true"))
