/**
 * `@caotang/tasks` — recurring agent tasks (agent-harness.md §12), headless.
 *
 * What is in here: the `tasks.json` model, its codec and recovery posture, when a task is due, and what a task may do. It is pure:
 * no clock, no time zone of its own, no model call, no storage. What is not: the schedule's clock, the run itself, the writer's
 * consent and the history of runs, which are the app's and are kept outside the project.
 */

export * from './model.js';
export * from './codec.js';
export * from './file.js';
export * from './due.js';
export * from './check.js';
export * from './ids.js';
export * from './runs.js';
