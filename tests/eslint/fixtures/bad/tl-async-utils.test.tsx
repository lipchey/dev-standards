import { render, waitFor } from "@testing-library/react";

test("never awaits waitFor", () => {
  render(<div>x</div>);
  waitFor(() => {
    expect(true).toBe(true);
  });
});
