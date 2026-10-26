/**
 * The scene-number placements have one home per package, and the two homes agree.
 *
 * `@caotang/bus` owns the recipe option's list and derives its type from it;
 * `@caotang/screenplay` owns the paginator's copy and derives its type from that,
 * because the dependency edge cannot run screenplay → bus. The two are therefore
 * allowed to be written twice but not to *drift*: the runtime check below fails the
 * moment one list gains or loses a placement the other does not have, and the
 * compile-time check fails the typecheck when the two *types* drift.
 *
 * The exporter depends on both packages, which is why the contract lives here.
 */
import { describe, expect, it } from 'vitest';
import { RECIPE_PAGE_SIZES, RECIPE_SCRIPT_FONTS, SCENE_NUMBER_OPTIONS as BUS_OPTIONS } from '@caotang/bus';
import type { RecipePageSize, RecipeScriptFont, SceneNumbersOption } from '@caotang/bus';
import { PAGE_SIZES, SCENE_NUMBER_PLACEMENTS as SCREENPLAY_PLACEMENTS, SCRIPT_FONTS } from '@caotang/screenplay';
import type { PageSize, SceneNumberPlacement, ScriptFont } from '@caotang/screenplay';

import type { ExportRecipeOptions, MediaRequest } from '../src/index.js';

/**
 * Whether two types are the same one. The identity test for a conditional type:
 * it holds only when the two types are the same, so a union that gains or loses a
 * member on one side alone is `false`.
 */
type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;

/*
 * The compile-time half of the contract: each union must fit the other, so a
 * placement the bus gains and the paginator does not name — or the other way
 * round — is a type error in this file, and the exporter's typecheck fails on it,
 * rather than a drift that turns up in a PDF nobody diffs.
 */
const _sameType: Equal<SceneNumberPlacement, SceneNumbersOption> = true;
const _busFitsPlacement: SceneNumbersOption extends SceneNumberPlacement ? true : false = true;
const _placementFitsBus: SceneNumberPlacement extends SceneNumbersOption ? true : false = true;

/*
 * The exporter's own two scene-number fields — the recipe option it reads and the
 * media request it renders from — are typed with the paginator's shared type, not
 * with a local copy of the union. The identities below fail the typecheck here, in
 * the file that owns the contract, if either field ever drifts from it.
 */
const _recipeOptionIsPlacement: Equal<NonNullable<ExportRecipeOptions['sceneNumbers']>, SceneNumberPlacement> = true;
const _mediaRequestIsPlacement: Equal<NonNullable<MediaRequest['sceneNumbers']>, SceneNumberPlacement> = true;

describe('the scene-number placements', () => {
  it('are the same list in the bus and in the paginator', () => {
    expect(SCREENPLAY_PLACEMENTS).toEqual(BUS_OPTIONS);
  });

  it('are the same type in the bus and in the paginator, in either direction', () => {
    // The assertions above are the check; these lines only say them out loud.
    expect(_sameType).toBe(true);
    expect(_busFitsPlacement).toBe(true);
    expect(_placementFitsBus).toBe(true);
  });

  it('are the type the exporter’s own recipe-option and media-request fields carry', () => {
    expect(_recipeOptionIsPlacement).toBe(true);
    expect(_mediaRequestIsPlacement).toBe(true);
  });

  it('are the four screenplay.md §5.3 names the recipe option offers', () => {
    // Pinned by name so a rename is caught here rather than in a PDF nobody diffs.
    expect([...BUS_OPTIONS]).toEqual(['off', 'left', 'right', 'both']);
  });
});

/**
 * The paper and the Latin face of the screenplay PDF have the same two homes. The bus owns the recipe option's lists; the
 * screenplay package owns the renderer's, and the edge cannot run screenplay → bus. The exporter depends on both.
 */
describe('the screenplay PDF’s paper and faces: one list in the bus, one in the renderer', () => {
  it('agree on the papers, the faces and their order', () => {
    expect([...RECIPE_PAGE_SIZES].sort()).toEqual([...PAGE_SIZES].sort());
    expect([...RECIPE_SCRIPT_FONTS]).toEqual([...SCRIPT_FONTS]);
  });

  it('agree as types, and the exporter’s recipe and request fields take them', () => {
    const _faces: Equal<ScriptFont, RecipeScriptFont> = true;
    const _papers: Equal<PageSize, RecipePageSize> = true;
    const _recipe: Equal<NonNullable<ExportRecipeOptions['scriptFont']>, ScriptFont> = true;
    const _request: Equal<NonNullable<MediaRequest['scriptFont']>, ScriptFont> = true;
    expect([_faces, _papers, _recipe, _request]).toEqual([true, true, true, true]);
  });
});
