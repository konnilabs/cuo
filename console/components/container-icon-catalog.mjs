// Product identity is independent of container names, tags and update policies.
// Only these exact repositories receive a brand mark; no substring matching.
export const brands = Object.freeze({
  nextcloud: {
    label: "Nextcloud",
    tone: 0,
    fallback: "cloud",
    pack: "cuo",
    images: [
      "nextcloud",
      "linuxserver/nextcloud",
      "lscr.io/linuxserver/nextcloud",
    ],
  },
  nginx: {
    label: "NGINX",
    tone: 1,
    images: ["nginx", "nginxproxy/nginx-proxy"],
  },
  redis: {
    label: "Redis",
    tone: 2,
    fallback: "database",
    pack: "lucide",
    images: ["redis", "redis/redis-stack", "redis/redis-stack-server"],
  },
  postgresql: {
    label: "PostgreSQL",
    tone: 3,
    fallback: "database",
    pack: "lucide",
    images: ["postgres", "postgresql", "pgvector/pgvector"],
  },
  vaultwarden: {
    label: "Vaultwarden",
    tone: 4,
    dark: "vaultwarden-light",
    images: [
      "vaultwarden",
      "vaultwarden/server",
      "ghcr.io/dani-garcia/vaultwarden",
    ],
  },
  appsmith: {
    label: "Appsmith",
    tone: 5,
    images: ["appsmith", "appsmith/appsmith-ce", "appsmith/appsmith-ee"],
  },
  portainer: {
    label: "Portainer",
    tone: 6,
    dark: "portainer-dark",
    images: ["portainer", "portainer/portainer-ce", "portainer/portainer-ee"],
  },
  immich: {
    label: "Immich",
    tone: 7,
    images: ["immich", "ghcr.io/immich-app/immich-server"],
  },
});

export function imageRepository(image) {
  if (
    typeof image !== "string" ||
    !image ||
    image.length > 1024 ||
    /\s|[?#\\]/.test(image) ||
    image.startsWith("sha256:")
  )
    return null;
  const parts = image.split("@");
  if (
    parts.length > 2 ||
    (parts.length === 2 && !/^sha256:[a-f0-9]{64}$/.test(parts[1]))
  )
    return null;
  let reference = parts[0];
  const colon = reference.lastIndexOf(":");
  if (colon > reference.lastIndexOf("/")) {
    if (!/^[\w][\w.-]{0,127}$/.test(reference.slice(colon + 1))) return null;
    reference = reference.slice(0, colon);
  }
  const segments = reference.split("/");
  let registry = "docker.io";
  if (
    segments.length > 1 &&
    (/[.:]/.test(segments[0]) || segments[0] === "localhost")
  )
    registry = segments.shift();
  if (!/^(?:[a-z0-9]+(?:[.-][a-z0-9]+)*)(?::[0-9]{1,5})?$/.test(registry))
    return null;
  if (registry === "index.docker.io" || registry === "registry-1.docker.io")
    registry = "docker.io";
  if (
    !segments.length ||
    segments.some(
      (part) =>
        !/^[a-z0-9]+(?:[._-]+[a-z0-9]+)*$/.test(part) || part.includes(".."),
    )
  )
    return null;
  if (registry === "docker.io" && segments.length === 1)
    segments.unshift("library");
  return registry + "/" + segments.join("/");
}

const repositories = new Map(
  Object.entries(brands).flatMap(([key, brand]) =>
    brand.images.map((image) => [imageRepository(image), key]),
  ),
);

export function resolveContainerIcon(
  image,
  { theme = "light", iconKey = "" } = {},
) {
  const repository = imageRepository(image);
  // A catalog key is the extension point for a future persisted manual choice.
  // It intentionally cannot be a URL, filename or executable SVG markup.
  const key = iconKey
    ? Object.hasOwn(brands, iconKey)
      ? iconKey
      : null
    : repositories.get(repository);
  const brand = key ? brands[key] : null;
  const leaf = repository?.split("/").pop();
  const fallback =
    brand?.fallback ||
    (leaf === "nextcloud"
      ? "cloud"
      : ["redis", "postgres", "postgresql"].includes(leaf)
        ? "database"
        : "cube");
  return {
    repository,
    key: key || null,
    icon: brand ? brand[theme === "dark" ? "dark" : "light"] || key : null,
    label: brand?.label || "Container",
    source: brand ? (iconKey ? "override" : "catalog") : "fallback",
    tone: brand?.tone ?? 1,
    fallback: {
      name: fallback,
      pack: brand?.pack || (fallback === "database" ? "lucide" : "cuo"),
    },
  };
}
