import Anthropic from "@anthropic-ai/sdk";
import { marked } from "marked";
import sanitizeHtml from "sanitize-html";
import type { Digest, DigestSection, DigestSource } from "./types";

export async function generateDigest(
  apiKey: string,
  topics: string[],
  previousDigests: Digest[],
  dashboardUrl: string,
  previousFunFacts: string[] = []
): Promise<Digest> {
  const model = "claude-sonnet-4-6";
  const client = new Anthropic({ apiKey });
  const today = new Date().toISOString().split("T")[0];

  const previousContext =
    previousDigests.length > 0
      ? `\n\nPrevious digests (avoid repeating, track developing stories):\n${previousDigests
          .map(
            (d) =>
              `--- ${d.date} ---\n${d.sections.map((s) => `${s.title}: ${s.content.slice(0, 200)}`).join("\n")}`
          )
          .join("\n\n")}`
      : "";

  const systemPrompt = `You are a concise news digest curator. Today is ${today}. Topics: ${topics.join(", ")}.

Search the web for each topic, then write a digest in this exact format:

subject: Brief catchy subject line

## Today's Updates
What happened today/last 24 hours (bullet points)

## This Week
Notable developments from the past 7 days (bullet points)

## Big Picture
Major trends across the topics (1-2 short paragraphs)

Rules:
- The first line MUST be "subject: ..." followed by a blank line, then the sections.
- Be concise. Short, punchy bullet points. No filler.
- If there's no significant news for a topic or section, just say "Nothing notable today" or similar. Don't stretch or fabricate.
- Not every section needs to be long.
- Use **bold** for emphasis, never _italics_ or *single asterisks*.
- Do not use underscores in markdown.${previousContext}`;

  let fullText = "";
  let stopReason: string | null = null;
  const citationMap = new Map<string, string>(); // url -> title
  let messages: Anthropic.MessageParam[] = [
    { role: "user", content: "Research and generate today's digest." },
  ];

  while (true) {
    const response = await client.beta.messages.create({
      model,
      max_tokens: 16000,
      system: systemPrompt,
      betas: ["web-fetch-2025-09-10"],
      tools: [
        {
          type: "web_search_20250305",
          name: "web_search",
          max_uses: 30,
        },
        {
          type: "web_fetch_20250910",
          name: "web_fetch",
          max_uses: 30,
        },
      ],
      messages,
    });

    stopReason = response.stop_reason;

    for (const block of response.content) {
      if (block.type === "text") {
        fullText += block.text;
        // Insert inline link for the first new citation on this text block
        const anyBlock = block as any;
        if (Array.isArray(anyBlock.citations)) {
          for (const cite of anyBlock.citations) {
            if (cite.type === "web_search_result_location" && cite.url) {
              if (!citationMap.has(cite.url)) {
                // First time seeing this source — insert inline link
                const domain = new URL(cite.url).hostname.replace(/^www\./, "");
                fullText += ` ([${domain}](${cite.url}))`;
              }
              citationMap.set(cite.url, cite.title || cite.url);
            }
          }
        }
      }
    }

    if (stopReason === "pause_turn") {
      messages = [
        ...messages,
        { role: "assistant", content: response.content },
        { role: "user", content: "Please continue." },
      ];
      fullText = "";
      citationMap.clear();
    } else {
      break;
    }
  }

  // Parse "subject: ..." from first line
  const subjectMatch = fullText.match(/^subject:\s*(.+)/im);
  const subject = subjectMatch ? subjectMatch[1].trim() : "Daily Digest";

  // Parse sections by ## headings
  const sectionRegex = /^##\s+(.+)/gm;
  const sections: DigestSection[] = [];
  let match: RegExpExecArray | null;
  const headings: { title: string; index: number }[] = [];
  while ((match = sectionRegex.exec(fullText)) !== null) {
    headings.push({ title: match[1].trim(), index: match.index + match[0].length });
  }
  for (let i = 0; i < headings.length; i++) {
    const start = headings[i].index;
    const end = i + 1 < headings.length ? fullText.lastIndexOf("##", headings[i + 1].index) : fullText.length;
    const content = fullText.slice(start, end).trim().replace(/^---+\s*/gm, "").replace(/\s*---+$/gm, "").trim();
    sections.push({ title: headings[i].title, content });
  }

  const sources: DigestSource[] = Array.from(citationMap, ([url, title]) => ({ url, title }));

  // Generate a fun fact in a separate request (max 3 web searches)
  const funFact = await generateFunFact(client, topics, previousFunFacts);

  const html = renderDigestHtml(subject, funFact, sections, sources, today, dashboardUrl);

  return { date: today, subject, funFact, sections, sources, html };
}

async function generateFunFact(
  client: Anthropic,
  topics: string[],
  previousFunFacts: string[]
): Promise<string> {
  const previousContext = previousFunFacts.length > 0
    ? `\n\nPrevious fun facts (DO NOT repeat any of these):\n${previousFunFacts.map((f, i) => `${i + 1}. ${f}`).join("\n")}`
    : "";

  try {
    const response = await client.beta.messages.create({
      model: "claude-sonnet-4-6",
      max_tokens: 1024,
      betas: ["web-fetch-2025-09-10"],
      tools: [
        {
          type: "web_search_20250305" as any,
          name: "web_search",
          max_uses: 3,
        },
      ],
      system: `You are a fun fact researcher. The user is interested in: ${topics.join(", ")}.

Pick ONE of these topics at random and find an obscure, surprising fun fact related to it. The reader is knowledgeable and motivated — avoid anything obvious or well-known. Dig for something genuinely surprising: a weird historical connection, a counterintuitive statistic, a strange origin story, an obscure record, etc.

Be varied across calls — rotate topics, alternate between historical facts, science facts, cultural trivia, statistics, etc.${previousContext}

Respond with ONLY the fun fact itself — one or two sentences, no preamble, no "Fun fact:" prefix, no quotation marks.`,
      messages: [
        { role: "user", content: "Find me an interesting fun fact." },
      ],
    });

    let text = "";
    for (const block of response.content) {
      if (block.type === "text") text += block.text;
    }

    if (response.stop_reason === "pause_turn") {
      // Tool use happened, need to continue
      const response2 = await client.beta.messages.create({
        model: "claude-sonnet-4-6",
        max_tokens: 1024,
        betas: ["web-fetch-2025-09-10"],
        tools: [
          {
            type: "web_search_20250305" as any,
            name: "web_search",
            max_uses: 0,
          },
        ],
        system: `Respond with ONLY the fun fact — one or two sentences, no preamble.`,
        messages: [
          { role: "user", content: "Find me an interesting fun fact." },
          { role: "assistant", content: response.content },
          { role: "user", content: "Please give me the fun fact now." },
        ],
      });
      text = "";
      for (const block of response2.content) {
        if (block.type === "text") text += block.text;
      }
    }

    return text.trim();
  } catch (e) {
    console.error("Fun fact generation failed:", e);
    return "";
  }
}

function renderDigestHtml(
  subject: string,
  funFact: string,
  sections: DigestSection[],
  sources: DigestSource[],
  date: string,
  dashboardUrl: string
): string {
  const funFactHtml = funFact ? `
    <div style="margin-bottom:24px;padding:16px 20px;background:#fef9f0;border-left:4px solid #e67e22;border-radius:0 8px 8px 0;">
      <p style="color:#b45309;font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:0.5px;margin:0 0 6px 0;">Did you know?</p>
      <p style="color:#92400e;font-size:14px;line-height:1.6;margin:0;">${escapeHtml(funFact)}</p>
    </div>` : "";

  const sectionHtml = sections
    .map(
      (s) => `
    <div style="margin-bottom:28px;">
      <h2 style="color:#e67e22;font-size:20px;margin:0 0 12px 0;border-bottom:2px solid #f0f0f0;padding-bottom:8px;">${escapeHtml(s.title)}</h2>
      <div style="color:#333;font-size:15px;line-height:1.7;">${markdownToHtml(s.content.trim())}</div>
    </div>`
    )
    .join("");

  const sourcesHtml = sources.length > 0 ? `
    <div style="margin-bottom:28px;">
      <h2 style="color:#e67e22;font-size:20px;margin:0 0 12px 0;border-bottom:2px solid #f0f0f0;padding-bottom:8px;">Sources</h2>
      <ul style="color:#555;font-size:13px;line-height:1.8;padding-left:20px;margin:0;">
        ${sources.map((s) => `<li><a href="${escapeHtml(s.url)}" style="color:#e67e22;text-decoration:none;">${escapeHtml(s.title)}</a></li>`).join("\n        ")}
      </ul>
    </div>` : "";

  return `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f5f5f5;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;">
  <div style="max-width:600px;margin:0 auto;padding:20px;">
    <div style="background:#fff;border-radius:12px;padding:32px;box-shadow:0 2px 8px rgba(0,0,0,0.06);">
      <div style="text-align:center;margin-bottom:24px;">
        <h1 style="color:#1a1a2e;font-size:24px;margin:0 0 4px 0;">${escapeHtml(subject)}</h1>
        <p style="color:#888;font-size:13px;margin:0;">${date} &middot; CN News Daily Digest</p>
      </div>
      ${funFactHtml}
      ${sectionHtml}
      ${sourcesHtml}
      <div style="text-align:center;padding-top:20px;border-top:1px solid #f0f0f0;">
        <p style="color:#aaa;font-size:12px;margin:0;">
          <a href="${dashboardUrl}" style="color:#e67e22;text-decoration:none;">Manage digest settings</a>
          &nbsp;&middot;&nbsp;
          <a href="${dashboardUrl.replace("/d/", "/unsubscribe/")}" style="color:#999;text-decoration:none;">Unsubscribe</a>
        </p>
        <p style="color:#ccc;font-size:11px;margin:6px 0 0;">Generated by CN News</p>
      </div>
    </div>
  </div>
</body>
</html>`;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function markdownToHtml(text: string): string {
  const raw = marked.parse(text, { async: false }) as string;
  return sanitizeHtml(raw, {
    allowedTags: [
      "p", "br", "a", "strong", "em", "b", "i",
      "ul", "ol", "li", "h1", "h2", "h3", "h4", "h5", "h6",
      "blockquote", "code", "pre", "hr", "div", "span",
    ],
    allowedAttributes: {
      a: ["href", "style", "class"],
      div: ["style", "class"],
      span: ["style", "class"],
      p: ["style", "class"],
    },
  });
}
