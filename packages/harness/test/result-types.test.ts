/**
 * `ToolResults` and the result specs are two declarations of one shape, and they must not drift. `SpecAgrees` compares the keys a
 * spec lists and the keys it requires with the type's, so a type test fails to compile when a field is added to one and not the
 * other. The runtime check (`testing.ts`) walks the nesting; this one is the top level, checked by the compiler.
 */

import { describe, expect, expectTypeOf, it } from 'vitest';

import { param } from '../src/index.js';
import { RESULT_SPECS, type ResultAgreement, type ResultData, type SpecAgrees, type ToolResults } from '../src/results.js';

describe('the typed result map', () => {
  it('agrees with the spec of every callable row, on the keys it has and the keys it requires', () => {
    // A row whose spec and type disagree makes its entry `false`, and `true` is not assignable from it.
    expectTypeOf<ResultAgreement>().toEqualTypeOf<{ readonly [N in keyof ToolResults]: true }>();
    expect(Object.keys(RESULT_SPECS).sort()).toEqual(expect.arrayContaining(['project.overview', 'tool.search', 'dialogue.apply']));
  });

  it('fails when a type gains a required key its spec lacks, loses one, or makes a required key optional', () => {
    const spec = param.object('A result.', { a: param.string('A.'), b: param.integer('B.') }, ['a']);
    type Spec = typeof spec;
    expect(spec.required).toEqual(['a']);
    expectTypeOf<SpecAgrees<Spec, { readonly a: string; readonly b?: number }>>().toEqualTypeOf<true>();
    expectTypeOf<SpecAgrees<Spec, { readonly a: string; readonly b: number }>>().toEqualTypeOf<false>();
    expectTypeOf<SpecAgrees<Spec, { readonly a?: string; readonly b?: number }>>().toEqualTypeOf<false>();
    expectTypeOf<SpecAgrees<Spec, { readonly a: string }>>().toEqualTypeOf<false>();
    expectTypeOf<SpecAgrees<Spec, { readonly a: string; readonly b?: number; readonly c?: number }>>().toEqualTypeOf<false>();
  });

  it('types a call by its literal name, and leaves any other name an open JSON object', () => {
    expectTypeOf<ResultData<'notes.append'>>().toEqualTypeOf<ToolResults['notes.append']>();
    expectTypeOf<ResultData<string>>().toEqualTypeOf<Readonly<Record<string, unknown>>>();
  });
});
