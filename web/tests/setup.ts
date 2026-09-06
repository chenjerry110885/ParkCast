/**
 * Test setup, run once per test file before anything in it.
 *
 * The `/vitest` entry point is the load-bearing part: it extends vitest's own
 * `expect` with the jest-dom matchers *and* the TypeScript declarations for
 * them, so `toBeInTheDocument()` and `toHaveAttribute()` are a compile error
 * when misspelled rather than a runtime "not a function". Importing the bare
 * package instead registers the matchers with jest's globals, which do not
 * exist here.
 */
import "@testing-library/jest-dom/vitest";
