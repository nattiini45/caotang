# Reader work counters

`measure-work.ts` injects counters into a test-only copy of the actual reader source. TypeScript visits every loop body and function callback; native string searches and slices charge the characters they inspect or return. A quadratic attribute scan or repeated suffix search therefore grows quadratically even when the machine is busy. The production source, reader APIs and bundle do not change.

Regex calls need a separate counter: counting one `exec` call would hide backtracking inside the engine. An isolated Node subprocess runs V8's regex interpreter with optimization and its excessive-backtrack fallback disabled. `%NewRegExpWithBacktrackLimit` finds the smallest successful positive backtrack budget by doubling and binary search. An end-of-input alternative distinguishes an ordinary failed match from an exhausted budget without stopping unanchored searching early. Sticky expressions use an empty alternative at their current position. The original expression supplies the real result and updates `lastIndex`; only the probe uses the alternative. Cached probes always reset `lastIndex`.

The totals include probe-alternative and per-call overhead; they are work units, not elapsed time or bytecode instruction counts. Node versions can have different linear constants, so the tests allow headroom and also run deliberately quadratic loops, repeated suffix searches and anchored/unanchored regex mutants. The counter must reject a regex over its linear ceiling. Unsupported V8 intrinsics or flags fail loudly rather than skipping the proof. The subprocess and test timeouts are only hang protection.

The text test keeps all seven 50,000-repeat hostile inputs, adds two smaller sizes, compares every instrumented result with the ordinary functions, and bounds JS visits, native scans and regex work separately. Its 128-unit-per-character regex ceiling allows for Node 22's larger linear constant, and a separate fourfold-input ratio must stay below ten. XML keeps the original input sizes, malformed-input results and 100,000-level stack-safety checks. RTF counts its entire reader and both runtime helpers, including paragraph assembly and finalization, at 10,000 and 40,000 paragraphs. It also uses its existing injected clock to count scanner deadline checks, but those checkpoints alone are not the linear-work proof. Both input sizes must be read completely.

Run the counter self-tests and the reader regressions with:

```sh
pnpm exec vitest run test/measure-work.test.ts packages/import-read/test/xml.test.ts packages/import-core/test/text.test.ts packages/import-rtf/test/rtf.test.ts
```
