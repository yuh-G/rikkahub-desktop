// Bun's `with { type: "file" }` import returns the on-disk path of the asset.
// At compile time bun --compile bundles the file into the exe and rewrites the
// path; at dev time it's the real disk path.
declare module "*.wasm" {
  const path: string;
  export default path;
}
