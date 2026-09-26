const PREFIX = "/tai-ve/crm-pc/v3/";

export default {
  async fetch(request, env) {
    if (request.method !== "GET" && request.method !== "HEAD") {
      return new Response("Method Not Allowed", { status: 405, headers: { Allow: "GET, HEAD" } });
    }

    const url = new URL(request.url);
    if (!url.pathname.startsWith(PREFIX)) return new Response("Not Found", { status: 404 });
    const key = url.pathname.slice(PREFIX.length);
    if (!key || key.includes("..") || key.includes("/")) return new Response("Not Found", { status: 404 });

    const ranged = request.headers.has("Range");
    const options = ranged ? { range: request.headers } : undefined;
    const object = await env.RELEASES.get(`v3/${key}`, options);
    if (!object) return new Response("Not Found", { status: 404 });

    const headers = new Headers();
    object.writeHttpMetadata(headers);
    headers.set("ETag", object.httpEtag);
    headers.set("X-Content-Type-Options", "nosniff");
    headers.set("Content-Disposition", `attachment; filename="${key}"`);
    headers.set("Cache-Control", key === "manifest.json" || key === "manifest.json.sig"
      ? "no-store, no-cache, must-revalidate"
      : "public, max-age=31536000, immutable");
    if (ranged && object.range) {
      const offset = object.range.offset ?? 0;
      const length = object.range.length ?? object.size;
      headers.set("Content-Range", `bytes ${offset}-${offset + length - 1}/${object.size}`);
      headers.set("Content-Length", String(length));
    } else {
      headers.set("Content-Length", String(object.size));
    }

    return new Response(request.method === "HEAD" ? null : object.body, {
      status: ranged && object.range ? 206 : 200,
      headers,
    });
  },
};
