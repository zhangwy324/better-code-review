; Declarations that JavaScript (and JSX) adds to javascript.scm, which runs first. They use node
; types the TypeScript grammars name differently (see typescript.scm).

; Class fields holding functions: `handle = () => {…}`.
(field_definition
  property: (property_identifier) @name
  value: [(arrow_function) (function_expression) (generator_function)]) @definition.method
