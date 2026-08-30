/**
 * Remote-dev only. Run with:
 *   npx wrangler dev scripts/whatsapp-meta-probe.ts --remote --name infra-api --port 8788
 * Do not deploy this file. It uses production infra-api bindings to inspect
 * (and only if a configured PIN exists, register) the real Infra number.
 */
import type { Env } from "../src/env";
import {
  inspectWhatsAppCloudRegistration,
  registerWhatsAppCloudPhoneNumber,
  resolveWhatsAppRegistrationPin,
} from "../src/services/whatsapp-register";

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/" || url.pathname === "/inspect") {
      const inspect = await inspectWhatsAppCloudRegistration(env);
      return Response.json({
        inspect,
        pinResolution: resolveWhatsAppRegistrationPin(env).ok
          ? { ok: true, source: resolveWhatsAppRegistrationPin(env).ok ? "secret" : undefined }
          : { ok: false, userActionRequired: resolveWhatsAppRegistrationPin(env).userActionRequired },
      });
    }
    if (url.pathname === "/register" && request.method === "POST") {
      const pin = resolveWhatsAppRegistrationPin(env);
      if (!pin.ok || !pin.pin) {
        return Response.json(
          {
            attempted: false,
            success: false,
            userActionRequired: pin.userActionRequired,
            inspect: await inspectWhatsAppCloudRegistration(env),
          },
          { status: 409 },
        );
      }
      return Response.json(await registerWhatsAppCloudPhoneNumber(env, pin.pin));
    }
    return Response.json({ error: "not_found" }, { status: 404 });
  },
};
