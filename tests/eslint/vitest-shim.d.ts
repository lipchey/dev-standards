/* The lint-only fixtures must not require the Vitest runtime at typecheck time. */
declare module 'vitest' {
  export const it: {
    (title: string, callback: () => void): void;
    only(title: string, callback: () => void): void;
  };

  export function expect(actual: unknown): {
    toBe(expected: unknown): void;
  };
}
