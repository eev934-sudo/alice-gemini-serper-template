const DEFAULT_GEMINI_MODEL = "gemini-3.5-flash-lite";
const DEFAULT_OPENAI_MODEL = "gpt-4o-mini";
const DEFAULT_ANTHROPIC_MODEL = "claude-haiku-5-5";
const MAX_HISTORY_MESSAGES = 8;
const MAX_HISTORY_MESSAGE_CHARS = 1200;
const MAX_ALICE_TEXT = 1024;
const TOTAL_RESPONSE_BUDGET_MS = 3600;
const SERPER_TIMEOUT_MS = 1000;
const MODEL_TIMEOUT_MS = 2500;
const GROUNDED_MODEL_TIMEOUT_MS = 3300;

function providerInfo() {
  if (process.env.ANTHROPIC_API_KEY) return { name: "Claude", maker: "Anthropic" };
  if (process.env.OPENAI_API_KEY) return { name: "ChatGPT", maker: "OpenAI" };
  return { name: "Gemini", maker: "Google" };
}

function isGeminiProvider() {
  return !process.env.ANTHROPIC_API_KEY && !process.env.OPENAI_API_KEY;
}

function groundingEnabled() {
  return isGeminiProvider() && String(process.env.GEMINI_GROUNDING || "").trim() === "1";
}

function currentDateTimeRu() {
  const tz = String(process.env.BOT_TIMEZONE || "Europe/Moscow").trim();
  try {
    const now = new Date();
    const date = new Intl.DateTimeFormat("ru-RU", {
      timeZone: tz, weekday: "long", day: "numeric", month: "long", year: "numeric"
    }).format(now);
    const time = new Intl.DateTimeFormat("ru-RU", {
      timeZone: tz, hour: "2-digit", minute: "2-digit"
    }).format(now);
    return `${date}, ${time} (часовой пояс ${tz})`;
  } catch (error) {
    return new Date().toISOString();
  }
}

function buildSystemPrompt() {
  const { name, maker } = providerInfo();
  return [
    `Ты — ${name}, модель искусственного интеллекта от ${maker}. Ты не Алиса и не ассистент Яндекса. Если спросят, кто ты, отвечай, что ты ${name}.`,
    `Текущая дата и время: ${currentDateTimeRu()}. Когда спрашивают про дату, день недели, время или про «сегодня», «вчера», «в этом году», опирайся на эту дату, а не на свои знания. Твои знания могли устареть, поэтому про свежие события полагайся на результаты поиска.`,
    "Твой ответ показывается и озвучивается в навыке Яндекс Алисы, поэтому отвечай по-русски, кратко и так, чтобы ответ было удобно слушать.",
    "Обычно используй 1–3 коротких предложения. Не используй Markdown, таблицы, списки с символами или длинные вступления. Не называй ссылки и адреса сайтов.",
    "Если вопрос требует актуальных данных и есть результаты поиска, опирайся на них; не выдумывай отсутствующие факты.",
    "Не придумывай ограничений: не говори, что сайт или сервис заблокирован в России или недоступен из-за региона, если этого нет в результатах поиска.",
    "Не начинай ответ с оговорок о том, что ты не можешь открывать сайты или приложения. Просто ответь по результатам поиска и своим знаниям. Если точных данных нет, назови то, что нашлось, с пометкой, что данные могут быть неточными, и коротко скажи, чего не хватило.",
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
  const t = String(text || "").trim();
  if (/^(привет|здравствуй|спасибо|пока|хватит|стоп|кто ты|что ты умеешь)/i.test(t)) return false;
  return t.split(/\s+/).length >= 3;
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
        body: JSON.stringify({ q: query, hl: "ru", num: 5 })
      },
      Math.min(SERPER_TIMEOUT_MS, timeoutMs)
    );

    if (!response.ok) {
      console.warn("Serper request failed with HTTP", response.status);
      return "";
    }

    const items = (Array.isArray(data.organic) ? data.organic : [])
      .slice(0, 5)
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

async function
