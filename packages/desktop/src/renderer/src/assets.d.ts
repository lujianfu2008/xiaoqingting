// Vite asset imports (must live in a script-format .d.ts — no top-level
// imports/exports — otherwise TS treats them as module augmentation).
declare module "*.vrm?url" {
  const src: string;
  export default src;
}
