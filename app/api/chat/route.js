import { NextResponse } from "next/server";

export const runtime = "nodejs";

const DEFAULT_MODEL = "deepseek-reasoner";
const DEFAULT_BASE_URL = "https://api.deepseek.com";

function buildSystemPrompt(dtMs) {
  const seconds = (Number(dtMs) / 1000).toFixed(2);
  return [
    "You are a conversational model that uses Time tokens to express.",
    "Time tokens look like [0.53S] and represent a pause in seconds.",
    `Prefer pauses in multiples of ${seconds}S when possible.`,
    "尽可能的理解和解读用户的输入中的time token来帮助你理解用户的输入。",
    "Keep temporal tokens inside the response text; do not explain them.",
    "Reply in a natural, compact tone."
  ].join(" ");
}

function buildPlainPrompt() {
  return [
    "You are a conversational model.",
    "Reply in a natural, compact tone.",
  ].join(" ");
}

export async function POST(request) {
  const apiKey = process.env.DEEPSEEK_API_KEY;
  if (!apiKey) {
    return NextResponse.json(
      { error: "Missing DEEPSEEK_API_KEY" },
      { status: 500 }
    );
  }

  const { message, dtMs, mode, systemPrompt: customSystemPrompt } = await request.json();
  if (!message) {
    return NextResponse.json({ error: "Missing message" }, { status: 400 });
  }

  const dtValue = Number.isFinite(Number(dtMs)) ? Number(dtMs) : 120;
  const systemPrompt =
    customSystemPrompt ||
    (mode === "plain" ? buildPlainPrompt() : buildSystemPrompt(dtValue));

  const payload = {
    model: process.env.DEEPSEEK_MODEL || DEFAULT_MODEL,
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: message }
    ],
    temperature: 0.7,
    max_tokens: 800
  };

  const baseUrl = process.env.DEEPSEEK_API_BASE || DEFAULT_BASE_URL;
  const response = await fetch(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(payload)
  });

  const data = await response.json();
  if (!response.ok) {
    return NextResponse.json(
      {
        error: data?.error?.message || "DeepSeek API error",
        detail: data
      },
      { status: response.status }
    );
  }

  const text = data?.choices?.[0]?.message?.content?.trim() || "";
  return NextResponse.json({ text });
}
