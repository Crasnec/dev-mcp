import { readFileSync } from "node:fs";
import Mustache from "mustache";

const directory = new URL("../views/", import.meta.url);
const cache = new Map<string, string>();

function template(name: string): string {
  if (!/^[a-z][a-z0-9/-]*$/.test(name)) {
    throw new Error("Invalid template name");
  }
  let source = cache.get(name);
  if (source === undefined || process.env.NODE_ENV !== "production") {
    source = readFileSync(new URL(name + ".mustache", directory), "utf8");
    cache.set(name, source);
  }
  return source;
}

export function renderFragment(
  name: string,
  model: Record<string, unknown>,
): string {
  const options = {
    escape: (value: unknown) =>
      String(value).replace(
        /[&<>"']/g,
        (character) =>
          ({
            "&": "&amp;",
            "<": "&lt;",
            ">": "&gt;",
            '"': "&quot;",
            "'": "&#39;",
          })[character]!,
      ),
  };
  return Mustache.render(template(name), model, template, options);
}

export function renderView(
  name: string,
  model: Record<string, unknown>,
  layout = "layouts/auth",
): string {
  const body = renderFragment(name, model);
  // Only rendered, escaped templates may supply the layout body.
  return renderFragment(layout, { ...model, body });
}
