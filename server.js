// Web Studio — сервер бота и API
//
// Что делает:
// 1. Telegram-бот: /start присылает кнопку "Открыть студию" (Web App)
// 2. /api/run: принимает заказ клиента и прогоняет его через 4 роли
//    (Директор -> Дизайнер -> Разработчик -> Паблишер) через Gemini API
// 3. Паблишер реально публикует готовый сайт на GitHub Pages и
//    возвращает клиенту рабочую ссылку

import express from "express";

const {
  GEMINI_API_KEY,
  TELEGRAM_BOT_TOKEN,
  MINI_APP_URL,
  GITHUB_TOKEN,
  GITHUB_OWNER,
  GITHUB_PAGES_REPO,
  PORT = 3000,
} = process.env;

const app = express();
app.set("trust proxy", 1);
app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.header("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.sendStatus(200);
  next();
});
app.use(express.json({ limit: "2mb" }));

const DIRECTOR_SYSTEM = `Ты — креативный директор AI-студии. К тебе поступает свободный текст заказа от клиента на создание сайта. Разбери его в чёткое техническое задание. Отвечай СТРОГО валидным JSON без markdown-обёртки, на языке заказа клиента:
{
  "site_type": "тип сайта",
  "business_name": "название бизнеса (придумай уместное, если не указано)",
  "audience": "целевая аудитория",
  "tone": "тон и характер бренда",
  "sections": ["раздел1", "раздел2"],
  "key_message": "главный посыл сайта"
}`;

const DESIGNER_SYSTEM = `Ты — дизайнер AI-студии. На основе технического задания придумай визуальную концепцию. Отвечай СТРОГО валидным JSON без markdown-обёртки:
{
  "palette": [{"name":"название", "hex":"#rrggbb"}],
  "display_font": "шрифт для заголовков (Google Font)",
  "body_font": "шрифт для текста (Google Font)",
  "layout_concept": "краткое описание композиции",
  "signature_element": "яркий запоминающийся элемент"
}`;

const DEVELOPER_SYSTEM = `Ты — фронтенд-разработчик AI-студии. На основе ТЗ и дизайн-концепции создай полностью готовый одностраничный сайт: один HTML-файл со встроенным <style>. Подключи шрифты через Google Fonts. Сайт адаптивный, современный, с реальным связным текстом (без Lorem Ipsum). Ответь ТОЛЬКО HTML-кодом, первый символ ответа — "<".`;

const PUBLISHER_SYSTEM = `Ты — паблишер AI-студии. Тебе передают ТЗ по готовому сайту. Напиши короткое дружелюбное сообщение клиенту (2-3 предложения, на языке ТЗ) о том, что сайт готов. Ответь только текстом сообщения.`;

function stripFences(text) {
  return text.trim().replace(/^```(?:json|html)?\n?/i, "").replace(/```$/, "").trim();
}

function parseJSON(text) {
  const clean = stripFences(text);
  try {
    return JSON.parse(clean);
  } catch {
    const m = clean.match(/\{[\s\S]*\}/);
    if (m) { try { return JSON.parse(m[0]); } catch {} }
    return null;
  }
}

async function callGemini(system, userPrompt, maxTokens = 2000) {
  const model = "gemini-2.5-flash";
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-goog-api-key": GEMINI_API_KEY,
    },
    body: JSON.stringify({
      system_instruction: { parts: [{ text: system }] },
      contents: [{ role: "user", parts: [{ text: userPrompt }] }],
      generationConfig: { maxOutputTokens: maxTokens },
    }),
  });
  if (!res.ok) throw new Error(`Gemini API ${res.status}: ${await res.text()}`);
  const data = await res.json();
  const parts = data?.candidates?.[0]?.content?.parts || [];
  return parts.map((p) => p.text || "").join("\n");
}

function slugify(str) {
  return (str || "site")
    .toLowerCase()
    .replace(/[^a-z0-9а-я]+/gi, "-")
    .replace(/(^-|-$)/g, "")
    .slice(0, 40) || "site";
}

async function publishToGithubPages(html, businessName) {
  if (!GITHUB_TOKEN || !GITHUB_OWNER || !GITHUB_PAGES_REPO) {
    return { url: null, note: "GitHub не настроен — сайт не опубликован, только сгенерирован." };
  }
  const slug = `${slugify(businessName)}-${Date.now().toString(36)}`;
  const path = `sites/${slug}/index.html`;
  const apiUrl = `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_PAGES_REPO}/contents/${path}`;

  const res = await fetch(apiUrl, {
    method: "PUT",
    headers: {
      Authorization: `Bearer ${GITHUB_TOKEN}`,
      Accept: "application/vnd.github+json",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      message: `Публикация сайта: ${businessName}`,
      content: Buffer.from(html, "utf-8").toString("base64"),
    }),
  });
  if (!res.ok) throw new Error(`GitHub API ${res.status}: ${await res.text()}`);

  const url = `https://${GITHUB_OWNER}.github.io/${GITHUB_PAGES_REPO}/sites/${slug}/`;
  return { url, note: "Опубликовано на GitHub Pages." };
}

app.post("/api/run", async (req, res) => {
  try {
    const { order } = req.body;
    if (!order || !order.trim()) return res.status(400).json({ error: "Пустой заказ" });

    const briefRaw = await callGemini(DIRECTOR_SYSTEM, order, 1000);
    const brief = parseJSON(briefRaw);
    if (!brief) throw new Error("Директор вернул некорректный формат брифа");

    const designRaw = await callGemini(DESIGNER_SYSTEM, JSON.stringify(brief), 800);
    const design = parseJSON(designRaw);
    if (!design) throw new Error("Дизайнер вернул некорректный формат концепции");

    const htmlRaw = await callGemini(DEVELOPER_SYSTEM, JSON.stringify({ brief, design }), 6000);
    const html = stripFences(htmlRaw);

    const publish = await publishToGithubPages(html, brief.business_name);

    const message = (await callGemini(PUBLISHER_SYSTEM, JSON.stringify({ brief, url: publish.url }), 400)).trim();

    res.json({ brief, design, html, message, publishedUrl: publish.url, publishNote: publish.note });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

app.get("/health", (_req, res) => res.send("ok"));

app.post("/telegram/webhook", async (req, res) => {
  const msg = req.body.message;
  if (msg?.text === "/start") {
    await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: msg.chat.id,
        text: "Привет! Здесь можно оформить заказ на сайт — команда AI-агентов соберёт его за пару минут.",
        reply_markup: {
          inline_keyboard: [[{ text: "🖥 Открыть студию", web_app: { url: MINI_APP_URL } }]],
        },
      }),
    });
  }
  res.sendStatus(200);
});

app.get("/telegram/set-webhook", async (req, res) => {
  const publicUrl = `${req.protocol}://${req.get("host")}/telegram/webhook`;
  const r = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/setWebhook?url=${encodeURIComponent(publicUrl)}`);
  res.json(await r.json());
});

app.listen(PORT, () => console.log(`Web Studio server on :${PORT}`));
