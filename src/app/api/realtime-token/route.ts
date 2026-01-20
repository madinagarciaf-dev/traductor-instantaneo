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

  const body = {
    // Configuración estándar que te funcionaba
    expires_after: { anchor: "created_at", seconds: 600 },
    session: {
      type: "realtime",        // IMPORTANTE: Lo había quitado y es obligatorio
      model: "gpt-4o-realtime-preview-2024-12-17", // Usamos la versión estable con VAD
      
      // 👇 LO ÚNICO NUEVO QUE AÑADIMOS 👇
      modalities: ["audio", "text"], 
      input_audio_transcription: {
        model: "whisper-1", 
      },
      // 👆 FIN DE LO NUEVO 👆

      audio: {
        input: {
          turn_detection: {
            type: "server_vad",
            threshold: 0.5,
            prefix_padding_ms: 300,
            silence_duration_ms: 200,
            create_response: false, // Manual
            interrupt_response: false, // Manual
          },
        },
        output: { voice },
      },
      instructions: `Eres un intérprete simultáneo.
        El hablante habla en ${peer}.
        Responde SIEMPRE en ${my}.
        Traduce fielmente y en el mismo orden.
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
    // Esto nos dirá en la consola de Vercel por qué falla si vuelve a pasar
    console.error("OpenAI Error:", data); 
    return NextResponse.json(
      { error: "OpenAI error", details: data },
      { status: r.status }
    );
  }

  return NextResponse.json(data);
}