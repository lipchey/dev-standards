/* The focused-test fixture is lint-only and must not require the Vitest runtime at typecheck time. */
declare module 'vitest' {
  export const it: {
    only(title: string, callback: () => void): void;
  };

  export function expect(actual: unknown): {
    toBe(expected: unknown): void;
  };
}
