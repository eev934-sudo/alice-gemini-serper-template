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
    "Никогда не утверждай, что событие не происходило, только потому что ты о нём не знаешь или поиск ничего не дал: твои знания устарели. Если результатов поиска нет или они не подтверждают событие, скажи, что в найденном подтверждения нет, но это не значит, что события не было. Если пользователь говорит, что нашёл новость, не спорь, а прими это как данные и уточни детали.",
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
