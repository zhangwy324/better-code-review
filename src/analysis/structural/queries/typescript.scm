; Declarations that TypeScript and TSX add to javascript.scm, which runs first.

(abstract_class_declaration
  name: (type_identifier) @name) @definition.class

(interface_declaration
  name: (type_identifier) @name) @definition.interface

(type_alias_declaration
  name: (type_identifier) @name) @definition.type

(enum_declaration
  name: (identifier) @name) @definition.enum

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
