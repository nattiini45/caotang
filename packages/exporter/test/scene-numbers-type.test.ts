/**
 * Pinned types: SceneNumbersOption in @caotang/bus and SceneNumberPlacement in @caotang/screenplay.
 *
 * Screenplay cannot depend on bus without violating the dependency graph (screenplay is a leaf engine).
 * This test verifies that the bus options list and the screenplay placements list are identical at runtime
 * and that their TypeScript types are mutually assignable.
 */

import { describe, expect, it } from 'vitest';
import { SCENE_NUMBER_OPTIONS, type SceneNumbersOption } from '@caotang/bus';
import { SCENE_NUMBER_PLACEMENTS, type SceneNumberPlacement } from '@caotang/screenplay';

type Same<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;

describe('scene numbers recipe option types', () => {
  it('has identical runtime options in bus and screenplay', () => {
    expect([...SCENE_NUMBER_PLACEMENTS]).toEqual([...SCENE_NUMBER_OPTIONS]);
  });

  it('is the same type in the bus and in the screenplay engine', () => {
    const same: Same<SceneNumbersOption, SceneNumberPlacement> = true;
    expect(same).toBe(true);
  });
});
