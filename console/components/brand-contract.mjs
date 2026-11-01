// Shared build/runtime validation: brand packs contain geometry, never URLs,
// markup, CSS, script, external references or arbitrary component properties.
export const geometryTags = new Set([
  "path",
  "line",
  "circle",
  "rect",
  "polyline",
  "polygon",
  "ellipse",
]);
export const geometryAttrs = new Set([
  "d",
  "x",
  "y",
  "x1",
  "x2",
  "y1",
  "y2",
  "cx",
  "cy",
  "r",
  "rx",
  "ry",
  "width",
  "height",
  "points",
  "fill",
  "stroke",
  "stroke-width",
  "stroke-linecap",
  "stroke-linejoin",
  "stroke-miterlimit",
  "opacity",
  "fill-rule",
  "clip-rule",
  "transform",
]);
const only = (value, keys) =>
  value &&
  typeof value === "object" &&
  !Array.isArray(value) &&
  Object.keys(value).every((key) => keys.includes(key));
export function validateBrandPack(pack) {
  if (
    !only(pack, ["schema", "id", "icons"]) ||
    pack.schema !== "cuo.brand-pack.v1" ||
    pack.id !== "cuo-brands" ||
    !pack.icons ||
    typeof pack.icons !== "object" ||
    Array.isArray(pack.icons)
  )
    throw Error("Invalid brand pack");
  const records = Object.entries(pack.icons);
  if (!records.length || records.length > 128)
    throw Error("Invalid brand pack size");
  for (const [name, record] of records) {
    if (
      !/^[a-z][a-z0-9-]{0,63}$/.test(name) ||
      !only(record, ["viewBox", "nodes"])
    )
      throw Error("Invalid brand record");
    const box =
      typeof record.viewBox === "string"
        ? record.viewBox.trim().split(/[ ,]+/).map(Number)
        : [];
    if (
      box.length !== 4 ||
      !box.every(Number.isFinite) ||
      box[2] <= 0 ||
      box[3] <= 0 ||
      !Array.isArray(record.nodes) ||
      !record.nodes.length ||
      record.nodes.length > 256
    )
      throw Error("Invalid brand geometry");
    for (const node of record.nodes) {
      if (
        !only(node, ["tag", "attrs"]) ||
        !geometryTags.has(node.tag) ||
        !node.attrs ||
        typeof node.attrs !== "object" ||
        Array.isArray(node.attrs)
      )
        throw Error("Invalid brand node");
      for (const [key, value] of Object.entries(node.attrs)) {
        if (
          !geometryAttrs.has(key) ||
          typeof value !== "string" ||
          value.length > 100000 ||
          /[\u0000-\u0008\u000b\u000c\u000e-\u001f]|url\s*\(|expression\s*\(|[<>]/i.test(
            value,
          )
        )
          throw Error("Invalid brand attribute");
      }
    }
  }
  return pack;
}
