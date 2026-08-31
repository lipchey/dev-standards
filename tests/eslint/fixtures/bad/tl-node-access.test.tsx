import { render, screen } from "@testing-library/react";

test("reaches into the rendered DOM", () => {
  render(<div>x</div>);
  const element = screen.getByText("x");
  expect(element.firstChild).toBeInTheDocument();
});
