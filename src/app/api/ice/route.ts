//src\app\api\ice\route.ts
import { NextResponse } from "next/server";
import twilio from "twilio";

export const runtime = "nodejs"; // importante en Vercel (Node runtime)

export async function GET() {
  const accountSid = process.env.TWILIO_ACCOUNT_SID;
  const authToken = process.env.TWILIO_AUTH_TOKEN;

  if (!accountSid || !authToken) {
    return NextResponse.json(
      { error: "Faltan TWILIO_ACCOUNT_SID o TWILIO_AUTH_TOKEN en variables de entorno" },
      { status: 500 }
    );
  }

  const client = twilio(accountSid, authToken);

  // Token efímero con credenciales TURN/STUN (ajusta ttl si quieres)
  const token = await client.tokens.create({ ttl: 3600 });

  const iceServers = (token as any).iceServers ?? (token as any).ice_servers ?? [];

  const res = NextResponse.json({ iceServers });
  res.headers.set("Cache-Control", "no-store");
  return res;
}
