import { render, screen } from "@testing-library/react";

test("queries through screen and awaits findBy", async () => {
  render(<div>x</div>);
  expect(await screen.findByText("x")).toBeInTheDocument();
});
