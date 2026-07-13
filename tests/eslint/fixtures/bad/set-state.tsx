import { useState } from "react";
export default function C() {
  const [n, setN] = useState(0);
  setN(1);
  return <span>{n}</span>;
}
