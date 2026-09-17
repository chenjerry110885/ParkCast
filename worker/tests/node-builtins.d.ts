/**
 * The three Node built-in signatures `weekFixture.test.ts` needs to read a file
 * off disk, and nothing else.
 *
 * `worker/tsconfig.json` sets `"types": []` deliberately -- the Worker runtime
 * is not Node, and letting Node's globals in would let a `Buffer` or a
 * `process.env` compile here and fail in production. `@types/node` is not
 * installed either, and pulling it in for three function signatures would mean
 * a new devDependency and a lockfile change on a branch whose whole point is
 * that neither moved.
 *
 * So the test declares exactly what it calls. Nothing else from Node becomes
 * visible, and the deliberate omission above keeps its meaning: `src/` still
 * cannot reach for a Node API by accident, because there is no Node API here
 * to reach for beyond reading a fixture.
 */
declare module "node:fs" {
  export function readFileSync(path: string): Uint8Array;
}

declare module "node:path" {
  export function dirname(path: string): string;
  export function join(...parts: string[]): string;
}

declare module "node:url" {
  export function fileURLToPath(url: string): string;
}
