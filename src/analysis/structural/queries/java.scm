; Declarations in Java.
; Conventions (see ../README.md): `@definition.<kind>` captures the declaration, `@name` its
; name, and `(#set! test "true")` marks a test. When several patterns capture the same
; declaration, the earliest pattern sets the kind, so specific patterns come first.

; `import a.b.C;`, `import a.b.*;`, `import static a.B.c;`. The name is the imported path.
(import_declaration
  [(scoped_identifier) (identifier)] @name) @definition.import

(class_declaration
  name: (identifier) @name) @definition.class

(record_declaration
  name: (identifier) @name) @definition.class

(interface_declaration
  name: (identifier) @name) @definition.interface

(annotation_type_declaration
  name: (identifier) @name) @definition.interface

(enum_declaration
  name: (identifier) @name) @definition.enum

(constructor_declaration
  name: (identifier) @name) @definition.constructor

; Record compact constructors: `record R(int a) { R { … } }`
(compact_constructor_declaration
  name: (identifier) @name) @definition.constructor

(method_declaration
  name: (identifier) @name) @definition.method

; JUnit 4/5 test methods.
((method_declaration
  (modifiers [
    (marker_annotation name: (identifier) @_annotation)
    (annotation name: (identifier) @_annotation)
  ])
  name: (identifier) @name) @definition.method
  (#any-of? @_annotation "Test" "ParameterizedTest" "RepeatedTest" "TestFactory" "TestTemplate")
  (#set! test "true"))
