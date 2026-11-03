const allowed =
  /^\/api\/v1\/(process-runs(?:\/(?:[a-f0-9]{32}|plan-[a-f0-9]{32}))?|log-retention(?:\/(?:reset|rotate|compact))?|exports|hosts|containers|scans|update-candidates|update-runs|update-jobs(?:\/[a-f0-9]{32}(?:\/(?:approve|cancel))?)?|policies(?:\/[a-zA-Z0-9_.:-]{1,128})?|maintenance-windows|activity|events|registries(?:\/[a-f0-9]{32}(?:\/(?:probe|repositories|tags|artifact|storage|retention-preview))?)?|integrations\/github(?:\/[a-f0-9]{32}(?:\/(?:setup|install|probe|installations|repositories|workflows|runs))?)?|webhook-deliveries(?:\/[a-f0-9]{32}\/retry)?|release-sets|subscriptions(?:\/[a-f0-9]{32}(?:\/sync)?)?|permission-policy|permissions\/me|import-jobs)(?:\?[^#]*)?$/;
export async function coreRequest(input, context) {
  if (
    !input ||
    !allowed.test(input.path) ||
    !["GET", "POST", "PUT"].includes(input.method)
  )
    throw Error("Unsupported Core request");
  const principal = context.principal;
  if (!principal) throw Error("Authenticated principal required");
  const headers = {
    Authorization: "Bearer " + process.env.CUO_CORE_TOKEN,
    "X-CUO-Actor": principal.id,
    "X-CUO-Role": principal.role,
    "X-CUO-Hosts": principal.hosts.join(","),
    "Content-Type": "application/json",
  };
  if (input.key) headers["Idempotency-Key"] = input.key;
  const r = await fetch(
    (process.env.CUO_CORE_URL || "http://core:8091") + input.path,
    {
      method: input.method,
      headers,
      body: input.body === undefined ? undefined : JSON.stringify(input.body),
      signal: context.signal,
    },
  );
  return { status: r.status, body: await r.json() };
}
