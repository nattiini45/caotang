/**
 * One declaration per tool's params, read two ways: as the JSON Schema an MCP
 * client sees, and as the closed-set validator the harness runs.
 *
 * **Why one declaration.** extensibility.md §2 makes the registry the single
 * tool-declaration seam, and a separate hand-written schema beside a separate
 * validator is how a tool gains a parameter the validator refuses or loses one
 * the schema advertises. Both outputs are derived from `ParamSpec` here, so a
 * key exists in the schema if and only if the validator accepts it.
 *
 * **Closed by default.** An object spec refuses any key it does not declare
 * (`additionalProperties: false` on the schema side, the bus's
 * `requireDeclaredParams` rule on the validator side).
 *
 * **Deliberately small.** The subset here is what the tools need: strings,
 * integers, numbers, booleans, enums, arrays, objects, a two-way union and a
 * tagged union on one key, each of which may be `nullable`. It is not a general
 * JSON Schema implementation, and `validate.ts` (the harness) says exactly which
 * keywords it enforces.
 *
 * **One vocabulary for params and results.** A tool's result is declared with the
 * same specs (`ToolEntry.result`). `nullable` is what results need and params do
 * not: an input that omits a key says nothing with `null`, while
 * `project.overview` answers `session: null` on purpose. The input validator
 * refuses `null` wherever `nullable` is absent.
 *
 * **Why this file is in the bus.** A media module declares its
 * tools in the registry's entry shape, and that shape needs `param` and
 * `toJsonSchema`. The harness imports those modules, so a module that imported
 * them from the harness would close a cycle. This file has no imports, so the
 * bus, which every tool package already depends on, is the one place for it.
 * `@caotang/harness` re-exports every name here from `schema.ts`.
 */

export type ParamSpec =
  | StringSpec
  | IntegerSpec
  | NumberSpec
  | BooleanSpec
  | EnumSpec
  | ArraySpec
  | ObjectSpec
  | FreeObjectSpec
  | UnionSpec
  | TaggedSpec;

/**
 * An object whose keys are checked by something else. A plan step's params are the
 * params of whichever tool the step names, so the plan's own schema can say only
 * "an object"; the step's tool checks its keys when the step is preflighted.
 */
export interface FreeObjectSpec {
  readonly kind: 'free-object';
  readonly description: string;
  readonly nullable?: true;
}

export interface StringSpec {
  readonly kind: 'string';
  readonly description: string;
  /** Refuses a value that is empty or whitespace after trim (the bus's `requireNonBlankString`). */
  readonly nonBlank?: boolean;
  /** Code points, the unit the specs write their limits in. Exceeding it is a limit, not a shape error. */
  readonly maxLength?: number;
  /** The corrective hint for an overflow, when the generic "shorten it" would send the caller the wrong way. */
  readonly overflowHint?: string;
  readonly default?: string;
  readonly nullable?: true;
}

export interface IntegerSpec {
  readonly kind: 'integer';
  readonly description: string;
  readonly minimum?: number;
  readonly maximum?: number;
  readonly default?: number;
  readonly nullable?: true;
}

/** Any finite number, as a similarity score or a pace is. An integer spec is the whole-number case. */
export interface NumberSpec {
  readonly kind: 'number';
  readonly description: string;
  readonly minimum?: number;
  readonly maximum?: number;
  readonly default?: number;
  readonly nullable?: true;
}

export interface BooleanSpec {
  readonly kind: 'boolean';
  readonly description: string;
  readonly default?: boolean;
  readonly nullable?: true;
}

export interface EnumSpec {
  readonly kind: 'enum';
  readonly description: string;
  readonly values: readonly string[];
  readonly default?: string;
  readonly nullable?: true;
}

export interface ArraySpec {
  readonly kind: 'array';
  readonly description: string;
  readonly items: ParamSpec;
  /** A minimum is a shape refusal; a maximum is a limit, and says how to split. */
  readonly minItems?: number;
  readonly maxItems?: number;
  readonly unique?: boolean;
  readonly nullable?: true;
}

export interface ObjectSpec {
  readonly kind: 'object';
  readonly description: string;
  readonly properties: Readonly<Record<string, ParamSpec>>;
  readonly required: readonly string[];
  readonly nullable?: true;
}

/** An object spec that remembers its keys, as `param.object` returns it. It is an `ObjectSpec` wherever one is wanted. */
export interface ObjectSpecOf<P extends Readonly<Record<string, ParamSpec>>, R extends readonly string[]> extends ObjectSpec {
  readonly properties: P;
  readonly required: R;
}

/** `A | B` where the two options are told apart by JSON type, as `fields: [...] | "all"` is. */
export interface UnionSpec {
  readonly kind: 'union';
  readonly description: string;
  readonly options: readonly ParamSpec[];
  readonly nullable?: true;
}

/** An object whose `tag` key selects which variant's closed key set applies, as `ops[].action` does. */
export interface TaggedSpec {
  readonly kind: 'tagged';
  readonly description: string;
  readonly tag: string;
  readonly variants: Readonly<Record<string, ObjectSpec>>;
  readonly nullable?: true;
}

export type JsonSchema = { readonly [key: string]: unknown };

/* ------------------------------------------------------------------ *
 * Constructors. Each returns one spec and nothing else, so a tool's
 * params read as a list of declarations.
 * ------------------------------------------------------------------ */

export const param = {
  string(
    description: string,
    options: { nonBlank?: boolean; maxLength?: number; overflowHint?: string; default?: string } = {},
  ): StringSpec {
    return { kind: 'string', description, ...options };
  },
  integer(description: string, options: { minimum?: number; maximum?: number; default?: number } = {}): IntegerSpec {
    return { kind: 'integer', description, ...options };
  },
  number(description: string, options: { minimum?: number; maximum?: number; default?: number } = {}): NumberSpec {
    return { kind: 'number', description, ...options };
  },
  boolean(description: string, options: { default?: boolean } = {}): BooleanSpec {
    return { kind: 'boolean', description, ...options };
  },
  choice(description: string, values: readonly string[], options: { default?: string } = {}): EnumSpec {
    return { kind: 'enum', description, values, ...options };
  },
  list(
    description: string,
    items: ParamSpec,
    options: { minItems?: number; maxItems?: number; unique?: boolean } = {},
  ): ArraySpec {
    return { kind: 'array', description, items, ...options };
  },
  /** The keys stay literal in the return type, so a type test can compare a spec with the interface it stands for. */
  object<const P extends Readonly<Record<string, ParamSpec>>, const R extends readonly string[] = readonly []>(
    description: string,
    properties: P,
    required: R = [] as unknown as R,
  ): ObjectSpecOf<P, R> {
    return { kind: 'object', description, properties, required };
  },
  either(description: string, options: readonly ParamSpec[]): UnionSpec {
    return { kind: 'union', description, options };
  },
  freeObject(description: string): FreeObjectSpec {
    return { kind: 'free-object', description };
  },
  /** The same spec, also accepting `null`: a result's way to say "none", where a param omits the key. */
  nullable<S extends ParamSpec>(spec: S): S & { readonly nullable: true } {
    return { ...spec, nullable: true };
  },
  /**
   * A tagged union. The tag key is added to every variant here, as a required
   * one-value enum, so a variant cannot forget to declare the key that selects it.
   */
  tagged(description: string, tag: string, variants: Readonly<Record<string, ObjectSpec>>): TaggedSpec {
    const withTag: Record<string, ObjectSpec> = {};
    for (const [value, variant] of Object.entries(variants)) {
      withTag[value] = {
        ...variant,
        properties: { [tag]: { kind: 'enum', description: `the operation, always "${value}"`, values: [value] }, ...variant.properties },
        required: [tag, ...variant.required],
      };
    }
    return { kind: 'tagged', description, tag, variants: withTag };
  },
};

/** `name`, or `[name, 'null']` when the spec also accepts null. */
function typeOf(name: string, spec: { readonly nullable?: true }): string | string[] {
  return spec.nullable === true ? [name, 'null'] : name;
}

/** The JSON Schema an MCP client receives for one spec. Derived, never written by hand. */
export function toJsonSchema(spec: ParamSpec): JsonSchema {
  return schemaOf(spec, false);
}

/**
 * The JSON Schema of a tool's result. A closed row refuses a key its spec does not list, as a param schema does. An open row
 * (`resultClosed: false`) lists what it declares and allows more at every level, so declaring a result never breaks a tool that
 * has a key the spec has not caught up with.
 */
export function toResultSchema(spec: ObjectSpec, closed: boolean): JsonSchema {
  return schemaOf(spec, !closed);
}

function schemaOf(spec: ParamSpec, open: boolean): JsonSchema {
  const sub = (child: ParamSpec): JsonSchema => schemaOf(child, open);
  switch (spec.kind) {
    case 'string':
      return {
        type: typeOf('string', spec),
        description: spec.description,
        ...(spec.nonBlank === true ? { minLength: 1 } : {}),
        ...(spec.maxLength === undefined ? {} : { maxLength: spec.maxLength }),
        ...(spec.default === undefined ? {} : { default: spec.default }),
      };
    case 'integer':
    case 'number':
      return {
        type: typeOf(spec.kind, spec),
        description: spec.description,
        ...(spec.minimum === undefined ? {} : { minimum: spec.minimum }),
        ...(spec.maximum === undefined ? {} : { maximum: spec.maximum }),
        ...(spec.default === undefined ? {} : { default: spec.default }),
      };
    case 'boolean':
      return {
        type: typeOf('boolean', spec),
        description: spec.description,
        ...(spec.default === undefined ? {} : { default: spec.default }),
      };
    case 'enum':
      return {
        type: typeOf('string', spec),
        enum: spec.nullable === true ? [...spec.values, null] : [...spec.values],
        description: spec.description,
        ...(spec.default === undefined ? {} : { default: spec.default }),
      };
    case 'array':
      return {
        type: typeOf('array', spec),
        description: spec.description,
        items: sub(spec.items),
        ...(spec.minItems === undefined ? {} : { minItems: spec.minItems }),
        ...(spec.maxItems === undefined ? {} : { maxItems: spec.maxItems }),
        ...(spec.unique === true ? { uniqueItems: true } : {}),
      };
    case 'object': {
      const properties: Record<string, JsonSchema> = {};
      for (const [key, child] of Object.entries(spec.properties)) properties[key] = sub(child);
      return {
        type: typeOf('object', spec),
        description: spec.description,
        properties,
        required: [...spec.required],
        additionalProperties: open,
      };
    }
    case 'free-object':
      return { type: typeOf('object', spec), description: spec.description };
    case 'union':
      return {
        description: spec.description,
        anyOf: [...spec.options.map((option) => sub(option)), ...(spec.nullable === true ? [{ type: 'null' }] : [])],
      };
    case 'tagged':
      return {
        description: spec.description,
        oneOf: [
          ...Object.values(spec.variants).map((variant) => sub(variant)),
          ...(spec.nullable === true ? [{ type: 'null' }] : []),
        ],
      };
  }
}
