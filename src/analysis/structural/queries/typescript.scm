; Declarations that TypeScript and TSX add to javascript.scm, which runs first.

(abstract_class_declaration
  name: (type_identifier) @name) @definition.class

(interface_declaration
  name: (type_identifier) @name) @definition.interface

(type_alias_declaration
  name: (type_identifier) @name) @definition.type

(enum_declaration
  name: (identifier) @name) @definition.enum

; Namespaces are containers, like classes: `namespace A.B {…}`, `module M {…}` and ambient
; `declare module 'x' {…}`, named without the quotes. `declare global {…}` has no name and is
; not one.
(internal_module
  name: [(identifier) (nested_identifier)] @name) @definition.namespace

(module
  name: [(identifier) (nested_identifier)] @name) @definition.namespace

(module
  name: (string (string_fragment) @name)) @definition.namespace

; Overload signatures: `function f(a: string): void;` and, in classes, `m(a: string): void;`.
(function_signature
  name: (identifier) @name) @definition.function

(class_body
  (method_signature
    name: (property_identifier) @name
    (#eq? @name "constructor")) @definition.constructor)

(class_body
  (method_signature
    name: (_) @name) @definition.method)

(abstract_method_signature
  name: (_) @name) @definition.method

; Class fields holding functions: `handle = () => {…}`. JavaScript's equivalent is in
; javascript-only.scm.
(public_field_definition
  name: (property_identifier) @name
  value: [(arrow_function) (function_expression) (generator_function)]) @definition.method
