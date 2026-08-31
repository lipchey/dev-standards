import { render, screen } from "@testing-library/react";

test("asserts on the disabled property", () => {
  render(<button disabled type="button">x</button>);
  expect(screen.getByRole("button").disabled).toBe(true);
});
