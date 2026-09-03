import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { App } from "./App.js";
import "./app.css";

const container = document.querySelector("#root");
if (container === null) {
  throw new Error("Renderer root element is missing from index.html.");
}

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>
);
