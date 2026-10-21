import fs from "node:fs";

const shapes = {
  settings: '<path d="M5 7h14M5 17h14M9 4v6m6 4v6"/>',
  edt: '<path d="m8 6-6 6 6 6m8-12 6 6-6 6M14 3l-4 18"/>',
  "bsl-ls": '<circle cx="10" cy="10" r="6"/><path d="m15 15 6 6m-14-9 3-5 3 5"/>',
  "code-index": '<path d="m12 3 9 5-9 5-9-5zm-9 9 9 5 9-5M3 16l9 5 9-5"/>',
  policy: '<path d="m12 3 8 3v6c0 5-8 9-8 9s-8-4-8-9V6zm-4 9 3 3 5-6"/>',
  v8std: '<path d="M12 5v16M3 3c4-1 7 0 9 2 2-2 5-3 9-2v16c-4-1-7 0-9 2-2-2-5-3-9-2z"/>',
};
export function component_icons(component) {
  const body = shapes[component] || shapes.settings;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="0 0 24 24" fill="none" stroke="#737373" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">${body}</svg>`;
  return [{ src: "data:image/svg+xml;base64," + Buffer.from(svg).toString("base64"), mimeType: "image/svg+xml", sizes: ["64x64"] }];
}
export const plugin_icons = () => [{ src: "data:image/svg+xml;base64," + fs.readFileSync(new URL("../assets/icon.svg", import.meta.url)).toString("base64"), mimeType: "image/svg+xml", sizes: ["64x64"] }];
