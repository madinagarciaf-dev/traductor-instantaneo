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
  const my = searchParams.get("my") ?? "es";      // idioma que QUIERE oír este usuario
  const peer = searchParams.get("peer") ?? "hu";  // idioma que HABLA la otra persona
  const voice = searchParams.get("voice") ?? "alloy";

  const body = {
    // anchor para que no expire inmediatamente si hay lag
    expires_after: { anchor: "created_at", seconds: 600 },
    session: {
      // ✅ CAMBIO 1: Usamos el modelo específico, no el alias genérico
      model: "gpt-4o-realtime-preview-2024-12-17", 
      
      // ✅ CAMBIO 2: Exigimos audio Y texto (necesario para eventos de transcripción)
      modalities: ["audio", "text"],

      // ✅ CAMBIO 3: Activamos Whisper AQUÍ (Backend) para que sea nativo
      input_audio_transcription: {
        model: "whisper-1",
      },

      audio: {
        input: {
          turn_detection: {
            type: "server_vad",
            threshold: 0.5,
            prefix_padding_ms: 300,
            silence_duration_ms: 200,
            create_response: false, // Importante: gestionamos la respuesta manualmente
            interrupt_response: false, // Importante: gestionamos interrupción manualmente
          },
        },
        output: { voice },
      },
      instructions: `Eres un intérprete simultáneo.
        El hablante habla en ${peer}.
        Responde SIEMPRE en ${my}.
        Traduce fielmente y en el mismo orden.

        IMPORTANTE:
        - Si recibes varias intervenciones antes de responder, traduce TODAS en orden.
        - NO repitas contenido ya traducido en respuestas anteriores.
        - No añadas comentarios, solo la traducción.
        `.trim(),
    },
  };

  const r = await fetch("https://api.openai.com/v1/realtime/client_secrets", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  const data = await r.json();
  if (!r.ok) {
    return NextResponse.json(
      { error: "OpenAI error", details: data },
      { status: r.status }
    );
  }

  return NextResponse.json(data);
}