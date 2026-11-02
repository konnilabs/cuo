// Convert only the pinned upstream static templates to DOM construction at build
// time. Keep the real XTend router/drawer APIs without allowing HTML sinks in CUO.
import fs from "node:fs";
import crypto from "node:crypto";
import { parseFragment } from "../.framework/node_modules/parse5/dist/index.js";
fs.mkdirSync("vendor", { recursive: true });
const report = [];
const dependency = JSON.parse(fs.readFileSync("xtend.lock.json", "utf8"));
const approved = {
  xrouter: "278058d2786497811f1d0ff1fdd0a5959d1b899583e8ff6d9fde88f3c9b298ab",
  xdrawer: "ad04b0095e0aa4e72371666a512c60c3bed269ca0ba1e5f8c53101ccf8cc9bde",
};
for (const name of ["xrouter", "xdrawer"]) {
  const original = fs.readFileSync(`.framework/components/${name}.js`, "utf8");
  if (
    crypto.createHash("sha256").update(original).digest("hex") !==
    approved[name]
  )
    throw Error("Unreviewed XTend component source: " + name);
  let code = original.replace(/from '\.\//g, "from '../.framework/components/");
  let templates = 0;
  code = code.replace(
    /this\.shadowRoot\.innerHTML = `([\s\S]*?)`;/,
    (_, markup) => {
      templates++;
      markup = markup.replace("${componentStyleNonce(this.ownerDocument)}", "");
      if (markup.includes("${"))
        throw Error("Unreviewed dynamic component template");
      let index = 0;
      const lines = [];
      function emit(node, parent) {
        if (node.nodeName === "#comment") return;
        const id = "cuoNode" + index++;
        if (node.nodeName === "#text")
          lines.push(
            `const ${id}=document.createTextNode(${JSON.stringify(node.value)});`,
          );
        else {
          lines.push(
            `const ${id}=document.createElementNS(${JSON.stringify(node.namespaceURI)},${JSON.stringify(node.tagName)});`,
          );
          for (const attr of node.attrs || [])
            lines.push(
              `${id}.setAttribute(${JSON.stringify(attr.name)},${JSON.stringify(attr.value)});`,
            );
        }
        lines.push(`${parent}.appendChild(${id});`);
        for (const child of node.childNodes || []) emit(child, id);
      }
      for (const node of parseFragment(markup).childNodes)
        emit(node, "this.shadowRoot");
      return lines.join("\n");
    },
  );
  if (templates !== 1) throw Error("Pinned template changed");
  if (name === "xrouter") {
    let errors = 0;
    code = code.replace(
      /(this\._outlet|container)\.innerHTML = (this\._renderError\([^;]+\)|'');/g,
      (_, node, value) => {
        errors++;
        return value === "''"
          ? `${node}.replaceChildren();`
          : `${node}.replaceChildren(document.createTextNode(${value}));`;
      },
    );
    if (errors !== 8)
      throw Error("Pinned router error sinks changed: " + errors);
    // Errors are plain text; never parse provider or route values as markup.
    code = code.replace(
      /return `<div style="padding:2em;text-align:center">[\s\S]*?<\/div>`;/,
      "return `${msg.title}: ${msg.desc} ${details}`;",
    );
    code = "import '../components/route-marker.mjs';\n" + code;
    code = code.replace(
      "@import url('/components/xrouter-docs-shell.css');",
      "",
    );
  }
  if (
    /\.(?:innerHTML|outerHTML)\b|insertAdjacentHTML|document\.write/.test(code)
  )
    throw Error("Unexpected HTML sink");
  fs.writeFileSync(`vendor/${name}.mjs`, code);
  report.push({
    component: name,
    source: `XTend ${dependency.revision}/components/${name}.js`,
    before: crypto.createHash("sha256").update(original).digest("hex"),
    after: crypto.createHash("sha256").update(code).digest("hex"),
    adaptation: "Static DOM construction and text-only error rendering",
  });
}
fs.writeFileSync(
  "reports/xtend-dom-adaptations.json",
  JSON.stringify(report, null, 2) + "\n",
);
