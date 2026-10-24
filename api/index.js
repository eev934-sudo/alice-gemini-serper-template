const DEFAULT_GEMINI_MODEL = "gemini-3.5-flash-lite";
const DEFAULT_OPENAI_MODEL = "gpt-4o-mini";
const DEFAULT_ANTHROPIC_MODEL = "claude-haiku-5-5";
const MAX_HISTORY_MESSAGES = 8;
const MAX_HISTORY_MESSAGE_CHARS = 1200;
const MAX_ALICE_TEXT = 1024;
const TOTAL_RESPONSE_BUDGET_MS = 3600;
const SERPER_TIMEOUT_MS = 1000;
const MODEL_TIMEOUT_MS = 2500;

function providerInfo() {
  if (process.env.ANTHROPIC_API_KEY) return { name: "Claude", maker: "Anthropic" };
  if (process.env.OPENAI_API_KEY) return { name: "ChatGPT", maker: "OpenAI" };
  return { name: "Gemini", maker: "Google" };
}

function buildSystemPrompt() {
  const { name, maker } = providerInfo();
  return [
    `Ты — ${name}, модель искусственного интеллекта от ${maker}. Ты не Алиса и не ассистент Яндекса. Если спросят, кто ты, отвечай, что ты ${name}.`,
    "Твой ответ показывается и озвучивается в навыке Яндекс Алисы, поэтому отвечай по-русски, кратко и так, чтобы ответ было удобно слушать.",
    "Обычно используй 1–3 коротких предложения. Не используй Markdown, таблицы, списки с символами или длинные вступления.",
    "Если вопрос требует актуальных данных и переданы результаты поиска, опирайся на них; не выдумывай отсутствующие факты.",
    "Не придумывай ограничений: не говори, что сайт или сервис заблокирован в России или недоступен из-за региона, если этого нет в переданных результатах поиска.",
    "Ты не открываешь сайты сам: ты опираешься на переданные результаты поиска и на свои знания. Если точных данных нет (например, число подписчиков, цена, счёт матча), скажи, что в найденных результатах этого нет, и назови то, что нашлось, с пометкой, что данные могут быть неточными или устаревшими.",
    "На новостные и спорные темы отвечай по существу и нейтрально, опираясь на результаты поиска, если они есть.",
    "Если не знаешь ответа, честно скажи об этом."
  ].join(" ");
}

function aliceResponse(text, endSession = false, history = []) {
  return {
    version: "1.0",
    response: {
      text: fitAliceText(text),
      end_session: endSession
    },
    session_state: { history }
  };
}

function fitAliceText(value) {
  const text = String(value ?? "")
    .replace(/[\r\n\t]+/g, " ")
    .replace(/\s{2,}/g, " ")
    .trim();

  if (text.length <= MAX_ALICE_TEXT) return text || "Не удалось подготовить ответ.";

  const candidate = text.slice(0, MAX_ALICE_TEXT - 1);
  const sentenceEnd = Math.max(
    candidate.lastIndexOf(". "),
    candidate.lastIndexOf("! "),
    candidate.lastIndexOf("? ")
  );
  if (sentenceEnd >= 300) return candidate.slice(0, sentenceEnd + 1).trim();

  const lastSpace = candidate.lastIndexOf(" ");
  return (lastSpace > 200 ? candidate.slice(0, lastSpace) : candidate).trim() + "…";
}

function isSearchIntent(text) {
  return /\b(latest|today|current|news|weather|price|exchange rate|recent|search|look up|followers)\b|сегодня|сейчас|последн|новост|погод|курс валют|найди|поищи|актуальн|сколько стоит|свежие данные|что происходит|что случилось|расскажи про|беспилот|дрон|подписчик|сколько у|кто такой|кто такая/i.test(text);
}

function isExitIntent(text) {
  return /^(пока|выход|хватит|стоп|закончить|до свидания)(?:$|[\s.,!?])/i.test(text.trim());
}

function safeHistory(history) {
  if (!Array.isArray(history)) return [];
  return history
    .filter(item => item && (item.role === "user" || item.role === "model") && typeof item.text === "string")
    .slice(-MAX_HISTORY_MESSAGES)
    .map(item => ({ role: item.role, text: item.text.slice(0, MAX_HISTORY_MESSAGE_CHARS) }));
}

async function fetchJson(url, options, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(100, timeoutMs));
  try {
    const response = await fetch(url, { ...options, signal: controller.signal });
    const data = await response.json().catch(() => ({}));
    return { response, data };
  } finally {
    clearTimeout(timer);
  }
}

async function searchWeb(query, timeoutMs) {
  const key = process.env.SERPER_API_KEY;
  if (!key || timeoutMs < 150) return "";

  try {
    const { response, data } = await fetchJson(
      "https://google.serper.dev/search",
      {
        method: "POST",
        headers: {
          "X-API-KEY": key,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({ q: query, hl: "ru", num: 3 })
      },
      Math.min(SERPER_TIMEOUT_MS, timeoutMs)
    );

    if (!response.ok) {
      console.warn("Serper request failed with HTTP", response.status);
      return "";
    }

    const items = (Array.isArray(data.organic) ? data.organic : [])
      .slice(0, 3)
      .map((item, i) => {
        const title = String(item.title || "").slice(0, 180);
        const snippet = String(item.snippet || "").slice(0, 350);
        const link = String(item.link || "").slice(0, 240);
        return `${i + 1}. ${title}: ${snippet} ${link}`.trim();
      });

    const answerBox = data.answerBox?.answer || data.answerBox?.snippet;
    if (answerBox) items.unshift(`Краткий ответ поисковика: ${String(answerBox).slice(0, 350)}`);
    return items.length ? items.join("\n") : "";
  } catch (error) {
    console.warn("Serper request did not finish in time; continuing without search.");
    return "";
  }
}

function buildPrompt(text, searchContext) {
  return searchContext
    ? `${text}\n\nРезультаты поиска в интернете:\n${searchContext}\nИспользуй их только там, где они относятся к вопросу.`
    : text;
}

// Claude требует, чтобы сообщения начинались с user и роли чередовались.
function toClaudeMessages(history, prompt) {
  const result = [];
  const push = (role, content) => {
    if (!content) return;
    const last = result[result.length - 1];
    if (last && last.role === role) {
      last.content += "\n" + content;
    } else {
      result.push({ role, content });
    }
  };
  for (const item of safeHistory(history)) {
    push(item.role === "model" ? "assistant" : "user", item.text);
  }
  push("user", prompt);
  while (result.length && result[0].role !== "user") result.shift();
  return result;
}

async function askClaude(text, history, searchContext, timeoutMs) {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) throw new Error("MISSING_ANTHROPIC_KEY");
  if (timeoutMs < 250) throw new Error("TIME_BUDGET_EXHAUSTED");

  const model = String(process.env.ANTHROPIC_MODEL || DEFAULT_ANTHROPIC_MODEL).trim();
  if (!/^[A-Za-z0-9._:-]+$/.test(model)) throw new Error("INVALID_MODEL_NAME");

  const { response, data } = await fetchJson(
    "https://api.anthropic.com/v1/messages",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": key,
        "anthropic-version": "2023-06-01"
      },
      body: JSON.stringify({
        model,
        max_tokens: 300,
        system: buildSystemPrompt(),
        messages: toClaudeMessages(history, buildPrompt(text, searchContext))
      })
    },
    Math.min(MODEL_TIMEOUT_MS, timeoutMs)
  );

  if (!response.ok) {
    const status = Number(response.status);
    console.error("Anthropic request failed with HTTP", status, data?.error?.message || "");
    if (status === 401 || status === 403) throw new Error("ANTHROPIC_KEY_REJECTED");
    if (status === 404) throw new Error("ANTHROPIC_MODEL_NOT_FOUND");
    if (status === 429) throw new Error("MODEL_QUOTA");
    throw new Error("ANTHROPIC_REQUEST_FAILED");
  }

  const answer = (Array.isArray(data?.content) ? data.content : [])
    .map(part => (part?.type === "text" && typeof part.text === "string") ? part.text : "")
    .join("")
    .trim();

  if (!answer) {
    if (data?.stop_reason === "refusal") throw new Error("MODEL_BLOCKED");
    throw new Error("MODEL_EMPTY_RESPONSE");
  }
  if (data?.stop_reason === "max_tokens") {
    console.warn("Claude reached the output token limit.");
  }
  return answer;
}

async function askOpenAI(text, history, searchContext, timeoutMs) {
  const key = process.env.OPENAI_API_KEY;
  if (!key) throw new Error("MISSING_OPENAI_KEY");
  if (timeoutMs < 250) throw new Error("TIME_BUDGET_EXHAUSTED");

  const model = String(process.env.OPENAI_MODEL || DEFAULT_OPENAI_MODEL).trim();
  if (!/^[A-Za-z0-9._:-]+$/.test(model)) throw new Error("INVALID_MODEL_NAME");

  const messages = [
    { role: "system", content: buildSystemPrompt() },
    ...safeHistory(history).map(item => ({
      role: item.role === "model" ? "assistant" : "user",
      content: item.text
    })),
    { role: "user", content: buildPrompt(text, searchContext) }
  ];

  const { response, data } = await fetchJson(
    "https://api.openai.com/v1/chat/completions",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${key}`
      },
      body: JSON.stringify({
        model,
        messages,
        max_completion_tokens: 300
      })
    },
    Math.min(MODEL_TIMEOUT_MS, timeoutMs)
  );

  if (!response.ok) {
    const status = Number(response.status);
    console.error("OpenAI request failed with HTTP", status, data?.error?.message || "");
    if (status === 401 || status === 403) throw new Error("OPENAI_KEY_REJECTED");
    if (status === 404) throw new Error("OPENAI_MODEL_NOT_FOUND");
    if (status === 429) throw new Error("MODEL_QUOTA");
    throw new Error("OPENAI_REQUEST_FAILED");
  }

  const choice = data?.choices?.[0];
  const answer = String(choice?.message?.content || "").trim();

  if (!answer) {
    if (choice?.message?.refusal || choice?.finish_reason === "content_filter") {
      throw new Error("MODEL_BLOCKED");
    }
    throw new Error("MODEL_EMPTY_RESPONSE");
  }
  if (choice?.finish_reason === "length") {
    console.warn("OpenAI reached the output token limit.");
  }
  return answer;
}

async function askGemini(text, history, searchContext, timeoutMs) {
  const key = process.env.GEMINI_API_KEY;
  if (!key) throw new Error("MISSING_GEMINI_KEY");
  if (timeoutMs < 250) throw new Error("TIME_BUDGET_EXHAUSTED");

  const model = String(process.env.GEMINI_MODEL || DEFAULT_GEMINI_MODEL).trim();
  if (!/^[A-Za-z0-9._-]+$/.test(model)) throw new Error("INVALID_MODEL_NAME");

  const contents = safeHistory(history).map(item => ({
    role: item.role,
    parts: [{ text: item.text }]
  }));
  contents.push({ role: "user", parts: [{ text: buildPrompt(text, searchContext) }] });

  const { response, data } = await fetchJson(
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-goog-api-key": key
      },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: buildSystemPrompt() }] },
        contents,
        generationConfig: {
          temperature: 0.5,
          maxOutputTokens: 240
        }
      })
    },
    Math.min(MODEL_TIMEOUT_MS, timeoutMs)
  );

  if (!response.ok) {
    const status = Number(response.status);
    console.error("Gemini request failed with HTTP", status);
    if (status === 401 || status === 403) throw new Error("GEMINI_KEY_REJECTED");
    if (status === 429) throw new Error("MODEL_QUOTA");
    throw new Error("GEMINI_REQUEST_FAILED");
  }

  const candidate = data?.candidates?.[0];
  const answer = (candidate?.content?.parts || [])
    .map(part => typeof part.text === "string" ? part.text : "")
    .join("")
    .trim();

  if (!answer) {
    if (data?.promptFeedback?.blockReason) throw new Error("MODEL_BLOCKED");
    throw new Error("MODEL_EMPTY_RESPONSE");
  }
  if (candidate?.finishReason === "MAX_TOKENS") {
    console.warn("Gemini reached the output token limit.");
  }
  return answer;
}

function askModel(text, history, searchContext, timeoutMs) {
  // Приоритет: Claude, затем ChatGPT, затем Gemini — по тому, какой ключ задан в Vercel.
  if (process.env.ANTHROPIC_API_KEY) return askClaude(text, history, searchContext, timeoutMs);
  if (process.env.OPENAI_API_KEY) return askOpenAI(text, history, searchContext, timeoutMs);
  return askGemini(text, history, searchContext, timeoutMs);
}

function errorForUser(error) {
  switch (error?.message) {
    case "MISSING_GEMINI_KEY":
      return "Сервер пока не настроен. Проверьте переменную GEMINI_API_KEY в настройках Vercel.";
    case "MISSING_OPENAI_KEY":
      return "Сервер пока не настроен. Проверьте переменную OPENAI_API_KEY в настройках Vercel.";
    case "MISSING_ANTHROPIC_KEY":
      return "Сервер пока не настроен. Проверьте переменную ANTHROPIC_API_KEY в настройках Vercel.";
    case "GEMINI_KEY_REJECTED":
      return "Не удалось подключиться к Gemini. Проверьте API-ключ в настройках Vercel.";
    case "OPENAI_KEY_REJECTED":
      return "Не удалось подключиться к ChatGPT. Проверьте API-ключ в настройках Vercel.";
    case "ANTHROPIC_KEY_REJECTED":
      return "Не удалось подключиться к Claude. Проверьте API-ключ в настройках Vercel.";
    case "OPENAI_MODEL_NOT_FOUND":
      return "Модель ChatGPT не найдена. Проверьте переменную OPENAI_MODEL в настройках Vercel.";
    case "ANTHROPIC_MODEL_NOT_FOUND":
      return "Модель Claude не найдена. Проверьте переменную ANTHROPIC_MODEL в настройках Vercel.";
    case "MODEL_QUOTA":
      return "Сейчас превышен лимит запросов или закончились средства на счёте. Попробуйте позже.";
    case "MODEL_BLOCKED":
      return "Не получилось обработать этот запрос. Попробуйте спросить иначе.";
    case "TIME_BUDGET_EXHAUSTED":
    case "AbortError":
      return "Ответ не уложился в отведённое время. Попробуйте задать вопрос ещё раз, чуть короче.";
    default:
      return "Не получилось получить ответ от нейросети. Попробуйте ещё раз чуть позже.";
  }
}

export default async function handler(req, res) {
  if (req.method === "GET") {
    return res.status(200).json({
      ok: true,
      service: "alice-gemini-serper",
      message: "Webhook is ready. Yandex Dialogs should send POST requests to /api."
    });
  }

  if (req.method !== "POST") {
    res.setHeader("Allow", "GET, POST");
    return res.status(405).json({ error: "Method not allowed" });
  }

  const startedAt = Date.now();
  const remainingMs = () => TOTAL_RESPONSE_BUDGET_MS - (Date.now() - startedAt);
  const body = req.body && typeof req.body === "object" ? req.body : {};
  const text = String(body?.request?.command || body?.request?.original_utterance || "").trim();
  const oldHistory = safeHistory(body?.state?.session?.history);

  if (!text) {
    return res.status(200).json(aliceResponse(
      `Привет! Я ${providerInfo().name}. Могу ответить на вопрос или найти актуальную информацию. Что хочешь узнать?`,
      false,
      oldHistory
    ));
  }

  if (isExitIntent(text)) {
    return res.status(200).json(aliceResponse("Хорошо, до встречи!", true, []));
  }

  try {
    let searchContext = "";
    if (isSearchIntent(text) && process.env.SERPER_API_KEY) {
      searchContext = await searchWeb(text, Math.min(SERPER_TIMEOUT_MS, Math.max(0, remainingMs() - 2600)));
    }

    const answer = await askModel(
      text,
      oldHistory,
      searchContext,
      Math.max(0, Math.min(MODEL_TIMEOUT_MS, remainingMs() - 600))
    );

    const history = [
      ...oldHistory,
      { role: "user", text: text.slice(0, MAX_HISTORY_MESSAGE_CHARS) },
      { role: "model", text: answer.slice(0, MAX_HISTORY_MESSAGE_CHARS) }
    ].slice(-MAX_HISTORY_MESSAGES);

    return res.status(200).json(aliceResponse(answer, false, history));
  } catch (error) {
    const safeError = error?.message === "AbortError" ? "TIME_BUDGET_EXHAUSTED" : error;
    console.warn("Alice webhook returned a fallback response:", safeError?.message || "unknown error");
    return res.status(200).json(aliceResponse(errorForUser(safeError), false, oldHistory));
  }
}

export { aliceResponse, fitAliceText, isSearchIntent, safeHistory };
