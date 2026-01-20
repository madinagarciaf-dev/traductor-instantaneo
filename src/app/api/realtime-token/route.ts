// src/app/api/realtime-token/route.ts
import { NextResponse } from "next/server";

export const runtime = "nodejs";

export async function GET(req: Request) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    return NextResponse.json(
      { error: "Falta OPENAI_API_KEY en .env.local" },
      { status: 500 }
    );
  }

  const { searchParams } = new URL(req.url);
  const my = searchParams.get("my") ?? "es";
  const peer = searchParams.get("peer") ?? "hu";
  const voice = searchParams.get("voice") ?? "alloy";

  // Configuración plana para el endpoint /sessions
  const body = {
    model: "gpt-4o-realtime-preview-2024-12-17",
    modalities: ["audio", "text"], // ✅ Audio y Texto activados
    voice: voice,
    input_audio_transcription: {
      model: "whisper-1", // ✅ Transcripción activada
    },
    turn_detection: {
      type: "server_vad",
      threshold: 0.5,
      prefix_padding_ms: 300,
      silence_duration_ms: 200,
      create_response: false, // Manual
    },
    instructions: `Eres un intérprete simultáneo.
      El hablante habla en ${peer}.
      Responde SIEMPRE en ${my}.
      Traduce fielmente y en el mismo orden.
      `.trim(),
  };

  try {
    const r = await fetch("https://api.openai.com/v1/realtime/sessions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });

    const data = await r.json();

    if (!r.ok) {
      console.error("OpenAI Session Error:", data);
      return NextResponse.json(
        { error: "OpenAI error", details: data },
        { status: r.status }
      );
    }

    // ✅ TRUCO: Devolvemos el formato exacto que tu frontend espera
    // El frontend busca tokenData.value, así que se lo damos masticado.
    return NextResponse.json({
      value: data.client_secret.value, 
    });

  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}