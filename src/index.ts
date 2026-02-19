import { routePartykitRequest } from "partyserver";
import type { Env } from "./types";
import { landingPage } from "./html/landing";
import { dashboardPage } from "./html/dashboard";

export { DigestObject } from "./digest-object";

function digestCookie(id: string): string {
  return `digest_id=${id}; Path=/; Max-Age=${60 * 60 * 24 * 365}; SameSite=Lax; Secure; HttpOnly`;
}

function getDigestIdFromCookie(request: Request): string | null {
  const cookie = request.headers.get("cookie") ?? "";
  const match = cookie.match(/(?:^|;\s*)digest_id=([a-f0-9-]{36})/);
  return match ? match[1] : null;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method;

    // Landing page
    if (path === "/" && method === "GET") {
      const existingId = getDigestIdFromCookie(request);
      return new Response(landingPage(existingId), {
        headers: { "content-type": "text/html;charset=utf-8" },
      });
    }

    // Create new digest — just generate a UUID, DO is created lazily on connect
    if (path === "/api/create" && method === "POST") {
      const ct = request.headers.get("content-type") ?? "";
      if (!ct.includes("application/json")) {
        return new Response("Content-Type must be application/json", { status: 415 });
      }
      const id = crypto.randomUUID();
      return Response.json({ id }, {
        headers: { "set-cookie": digestCookie(id) },
      });
    }

    // Dashboard page
    const dashMatch = path.match(/^\/d\/([a-f0-9-]{36})$/);
    if (dashMatch && method === "GET") {
      return new Response(dashboardPage(dashMatch[1]), {
        headers: {
          "content-type": "text/html;charset=utf-8",
          "set-cookie": digestCookie(dashMatch[1]),
        },
      });
    }

    // Confirm subscription — /confirm/:uuid/:token
    const confirmMatch = path.match(/^\/confirm\/([a-f0-9-]{36})\/([a-f0-9-]{36})$/);
    if (confirmMatch && method === "GET") {
      const uuid = confirmMatch[1];
      const token = confirmMatch[2];
      const id = env.DIGEST_OBJECT.idFromName(uuid);
      const stub = env.DIGEST_OBJECT.get(id);
      const doUrl = new URL(request.url);
      doUrl.pathname = `/parties/digest-object/${uuid}/confirm/${token}`;
      return stub.fetch(new Request(doUrl.toString(), request));
    }

    // Unsubscribe — /unsubscribe/:uuid (GET shows confirmation, POST acts)
    const unsubMatch = path.match(/^\/unsubscribe\/([a-f0-9-]{36})$/);
    if (unsubMatch && (method === "GET" || method === "POST")) {
      const uuid = unsubMatch[1];
      const id = env.DIGEST_OBJECT.idFromName(uuid);
      const stub = env.DIGEST_OBJECT.get(id);
      const doUrl = new URL(request.url);
      doUrl.pathname = `/parties/digest-object/${uuid}/unsubscribe`;
      return stub.fetch(new Request(doUrl.toString(), request));
    }

    // Party routes — /parties/digest-object/{room}/...
    const partyResponse = await routePartykitRequest(request, env);
    if (partyResponse) return partyResponse;

    // Fall through to static assets
    return env.ASSETS.fetch(request);
  },
};
