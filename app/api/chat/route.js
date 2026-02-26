import { NextResponse } from "next/server";

export const runtime = "nodejs";

const DEFAULT_MODEL = "deepseek-reasoner";
const DEFAULT_BASE_URL = "https://api.deepseek.com";

export async function POST(request) {
  const apiKey = process.env.DEEPSEEK_API_KEY;
  if (!apiKey) {
    return NextResponse.json({ error: "Missing DEEPSEEK_API_KEY" }, { status: 500 });
  }

  const body = await request.json();

  // Support both single-message and multi-turn messages array
  const { message, messages, dtMs, mode, systemPrompt: customSystemPrompt } = body;

  if (!message && (!messages || messages.length === 0)) {
    return NextResponse.json({ error: "Missing message or messages" }, { status: 400 });
  }

  const systemPrompt = customSystemPrompt || "You are a conversational model. Reply in a natural, compact tone.";

  // Build the chat messages array
  const chatMessages = messages || [{ role: "user", content: message }];

  const payload = {
    model: process.env.DEEPSEEK_MODEL || DEFAULT_MODEL,
    messages: [{ role: "system", content: systemPrompt }, ...chatMessages],
    temperature: 0.7,
    max_tokens: 800,
  };

  const baseUrl = process.env.DEEPSEEK_API_BASE || DEFAULT_BASE_URL;
  const response = await fetch(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });

  const data = await response.json();
  if (!response.ok) {
    return NextResponse.json(
      { error: data?.error?.message || "DeepSeek API error", detail: data },
      { status: response.status }
    );
  }

  const text = data?.choices?.[0]?.message?.content?.trim() || "";
  return NextResponse.json({ text });
}
