import { it, expect } from "vitest";

/* Module-scoped, so the repo's DOM-free tsconfig stays that way for every other test. */
declare const document: { body: { querySelector(selector: string): unknown } };
declare const renderThing: (input: string) => string;

it("reads the DOM without importing Testing Library", () => {
  expect(document.body.querySelector("main")).toBe(null);
});

/* `wrapper` + a render-shaped name is what aggressive reporting mistakes for an RTL
   render: with the preset's three settings removed this line reports
   render-result-naming-convention. */
it("names a local render helper's result freely", () => {
  const wrapper = renderThing("x");
  expect(wrapper).toBe("x");
});
