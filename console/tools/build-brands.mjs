// Compile reviewed, commit/hash-pinned artwork into the geometry subset supported
// by XIcon. Runs offline; upstream files are never fetched by the build or UI.
import fs from "node:fs";
import crypto from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { SaxesParser } from "../.framework/node_modules/saxes/saxes.js";
import {
  geometryAttrs,
  geometryTags,
  validateBrandPack,
} from "../components/brand-contract.mjs";

const paint = new Set([
  "fill",
  "stroke",
  "stroke-width",
  "stroke-linecap",
  "stroke-linejoin",
  "stroke-miterlimit",
  "opacity",
  "fill-rule",
  "clip-rule",
]);
function declarations(style) {
  return Object.fromEntries(
    String(style || "")
      .split(";")
      .filter(Boolean)
      .map((part) => part.split(":").map((v) => v.trim()))
      .filter(([key]) => paint.has(key)),
  );
}
function parse(source) {
  const parser = new SaxesParser(),
    stack = [];
  let root;
  parser.on("doctype", () => {
    throw Error("SVG declarations are forbidden");
  });
  parser.on("opentag", ({ name, attributes }) => {
    const node = { tag: name, attrs: attributes, children: [], text: "" };
    if (stack.length) stack.at(-1).children.push(node);
    else root = node;
    stack.push(node);
  });
  parser.on("text", (text) => {
    if (stack.length) stack.at(-1).text += text;
  });
  parser.on("closetag", () => stack.pop());
  parser.write(source).close();
  if (root?.tag !== "svg") throw Error("Expected SVG root");
  return root;
}
function compile(source, id, rootFill) {
  const root = parse(source),
    classes = new Map(),
    nodes = [];
  function styles(node) {
    if (node.tag === "style") {
      if (/@|url\s*\(/i.test(node.text))
        throw Error("Unsupported SVG stylesheet");
      for (const match of node.text.matchAll(/\.([\w-]+)\s*\{([^{}]*)\}/g))
        classes.set(match[1], declarations(match[2]));
    }
    node.children.forEach(styles);
  }
  styles(root);
  function visit(node, inherited, transform = "") {
    if (["style", "title", "desc"].includes(node.tag)) return;
    // Portainer's reviewed clip rectangle encloses the artwork. Removing this
    // redundant viewport clip lets XIcon keep its strict geometry allowlist.
    if (node.tag === "defs") {
      if (!id.startsWith("portainer"))
        throw Error("Unreviewed SVG definitions");
      const clip = node.children[0],
        rect = clip?.children[0];
      if (
        node.children.length !== 1 ||
        clip?.tag !== "clipPath" ||
        clip.attrs.id !== "clip0_261_120684" ||
        rect?.tag !== "rect" ||
        rect.attrs.width !== "168.414" ||
        rect.attrs.height !== "218.719" ||
        rect.attrs.transform !== "translate(0.724609)"
      )
        throw Error("Portainer viewport clip changed");
      return;
    }
    if (!["svg", "g"].includes(node.tag) && !geometryTags.has(node.tag))
      throw Error("Unsupported SVG node: " + node.tag);
    const attrs = Object.fromEntries(
      Object.entries(node.attrs).filter(([key]) => geometryAttrs.has(key)),
    );
    for (const name of String(node.attrs.class || "").split(/\s+/)) {
      if (name && !classes.has(name)) throw Error("Unresolved SVG class");
      Object.assign(attrs, classes.get(name));
    }
    Object.assign(attrs, declarations(node.attrs.style));
    const nextTransform = [transform, attrs.transform]
      .filter(Boolean)
      .join(" ");
    delete attrs.transform;
    const inheritedPaint = {
      ...inherited,
      ...Object.fromEntries(
        Object.entries(attrs).filter(([key]) => paint.has(key)),
      ),
    };
    if (
      node.attrs["clip-path"] &&
      !(
        id.startsWith("portainer") &&
        node.attrs["clip-path"] === "url(#clip0_261_120684)"
      )
    )
      throw Error("Unreviewed SVG clipping");
    if (geometryTags.has(node.tag)) {
      nodes.push({
        tag: node.tag,
        attrs: {
          ...inheritedPaint,
          ...attrs,
          ...(nextTransform ? { transform: nextTransform } : {}),
        },
      });
    } else {
      if (attrs.opacity && attrs.opacity !== "1")
        throw Error("Group opacity needs explicit normalization");
      node.children.forEach((child) =>
        visit(child, inheritedPaint, nextTransform),
      );
    }
  }
  visit(root, { fill: rootFill || "#000000", stroke: "none" });
  return { viewBox: root.attrs.viewBox, nodes };
}

// Appsmith publishes a compact monochrome favicon in ICO form. Preserve its
// original pixels as horizontal SVG rectangles; no raster URL/runtime decoder.
function compileAppsmithIcon(bytes) {
  if (
    bytes.length !== 318 ||
    bytes.readUInt32LE(0) !== 65536 ||
    bytes.readUInt16LE(4) !== 1 ||
    bytes.readUInt32LE(18) !== 22 ||
    bytes.readUInt32LE(22) !== 40 ||
    bytes.readInt32LE(26) !== 16 ||
    bytes.readInt32LE(30) !== 32 ||
    bytes.readUInt16LE(36) !== 4 ||
    bytes.readUInt32LE(38) !== 0
  )
    throw Error("Unreviewed Appsmith favicon format");
  const nodes = [],
    pixels = 22 + 40 + 64,
    mask = pixels + 128;
  for (let y = 0; y < 16; y++) {
    const row = 15 - y;
    function color(x) {
      if (x >= 16 || bytes[mask + row * 4 + (x >> 3)] & (128 >> (x % 8)))
        return null;
      const index =
        (bytes[pixels + row * 8 + (x >> 1)] >> (x % 2 ? 0 : 4)) & 15;
      const offset = 22 + 40 + index * 4;
      return (
        "#" +
        [bytes[offset + 2], bytes[offset + 1], bytes[offset]]
          .map((v) => v.toString(16).padStart(2, "0"))
          .join("")
      );
    }
    for (let x = 0; x < 16;) {
      const fill = color(x),
        start = x++;
      while (x < 16 && color(x) === fill) x++;
      if (fill) {
        const previous = nodes.find(
          (node) =>
            node.attrs.x === String(start) &&
            node.attrs.width === String(x - start) &&
            node.attrs.fill === fill &&
            Number(node.attrs.y) + Number(node.attrs.height) === y,
        );
        // Merge equal runs vertically so scaling does not introduce seams
        // between adjacent one-pixel rectangles of the same color.
        if (previous)
          previous.attrs.height = String(Number(previous.attrs.height) + 1);
        else
          nodes.push({
            tag: "rect",
            attrs: {
              x: String(start),
              y: String(y),
              width: String(x - start),
              height: "1",
              fill,
              stroke: "none",
            },
          });
      }
    }
  }
  return { viewBox: "0 0 16 16", nodes };
}

export function buildBrandPack(
  directory = fileURLToPath(new URL("../brands/", import.meta.url)),
) {
  const lock = JSON.parse(
    fs.readFileSync(path.join(directory, "sources.lock.json"), "utf8"),
  );
  if (lock.schema !== "cuo.brand-sources.v1")
    throw Error("Unknown brand source lock");
  const pack = { schema: "cuo.brand-pack.v1", id: "cuo-brands", icons: {} };
  for (const entry of lock.sources) {
    if (
      !/^[a-z][a-z0-9-]*$/.test(entry.id) ||
      (entry.format !== undefined && !["svg", "ico"].includes(entry.format)) ||
      (entry.format === "ico" && entry.id !== "appsmith") ||
      entry.file !==
        "sources/" + entry.id + (entry.format === "ico" ? ".ico" : ".svg") ||
      !/^[a-f0-9]{40}$/.test(entry.revision) ||
      !entry.url.startsWith(
        "https://raw.githubusercontent.com/" +
          entry.repository +
          "/" +
          entry.revision +
          "/",
      )
    )
      throw Error("Invalid pinned brand source");
    const bytes = fs.readFileSync(path.join(directory, entry.file));
    if (
      crypto.createHash("sha256").update(bytes).digest("hex") !== entry.sha256
    )
      throw Error("Brand source integrity mismatch: " + entry.id);
    pack.icons[entry.id] =
      entry.format === "ico" && entry.id === "appsmith"
        ? compileAppsmithIcon(bytes)
        : compile(bytes.toString("utf8"), entry.id);
  }
  validateBrandPack(pack);
  return pack;
}

if (
  process.argv[1] &&
  fileURLToPath(import.meta.url) === path.resolve(process.argv[1])
) {
  const pack = buildBrandPack();
  fs.mkdirSync(new URL("../assets/", import.meta.url), { recursive: true });
  fs.writeFileSync(
    new URL("../assets/container-brands.json", import.meta.url),
    JSON.stringify(pack) + "\n",
  );
  console.log(
    "CUO: verified and compiled " +
      Object.keys(pack.icons).length +
      " local product icon variants.",
  );
}
