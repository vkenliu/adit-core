/**
 * TUI entry point — renders the Ink app.
 */

import React from "react";
import { render } from "ink";
import { App } from "./App.js";

export function launchTui(): void {
  render(React.createElement(App));
}
