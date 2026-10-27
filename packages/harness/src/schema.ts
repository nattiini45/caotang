/**
 * The tool params declaration, re-exported from `@caotang/bus` (`tool-schema.ts`). The declaration lives in the bus
 * so that a media module can declare its tools without importing this package, which imports those modules.
 * Every harness file that reads `ParamSpec`, `param` or `toJsonSchema` keeps its import from here.
 */

export {
  param,
  toJsonSchema,
  type ArraySpec,
  type BooleanSpec,
  type EnumSpec,
  type FreeObjectSpec,
  type IntegerSpec,
  type NumberSpec,
  type JsonSchema,
  type ObjectSpec,
  type ParamSpec,
  type StringSpec,
  type TaggedSpec,
  type UnionSpec,
} from '@caotang/bus';
