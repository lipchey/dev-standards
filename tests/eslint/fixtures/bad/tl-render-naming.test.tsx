import { render } from "@testing-library/react";

test("names the render result like an enzyme wrapper", () => {
  const wrapper = render(<div>x</div>);
  expect(wrapper).toBe(wrapper);
});
