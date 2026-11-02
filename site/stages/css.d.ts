// The stages and the kit import their stylesheets for the build's order (stages/render.tsx lists them); TypeScript only needs to know
// a .css import is a module. tools/build-site.mjs reads the files itself, and nothing here is bundled.
declare module '*.css';
