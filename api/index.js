const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const SERPER_API_KEY = process.env.SERPER_API_KEY;

const GEMINI_MODEL = process.env.GEMINI_MODEL || "gemini-2.5-flash-lite";
const BOT_TIMEZONE = process.env.BOT_TIMEZONE || "Europe/Moscow";

// Лимит Алисы для навыка — 4,5 с на всё (доставка запроса, работа, доставка ответа).
// Оставляем запас на сеть.
const TOTAL_RESPONSE_BUDGET_MS = 4000;
const SERPER_TIMEOUT_MS = 1200;
const MIN_MODEL_TIME_MS = 1800;
const MODEL_TIMEOUT_MS = 3300;
const MAX_HISTORY_MESSAGES = 6;
const MAX_NEWS_RESULTS = 4;
const MAX_WEB_RESULTS = 4;
const MAX_ANSWER_LENGTH = 1000;

const NO_SEARCH_NOTE =
  "ПОИСК НЕ ДАЛ РЕЗУЛЬТАТОВ ИЛИ НЕ УСПЕЛ ОТВЕТИТЬ. Свежих данных нет: отвечай осторожно, не отрицай события и скажи, что точных свежих данных найти не удалось.";

function currentDateTimeRu() {
  try {
    const now = new Date();
    const date = new Intl.DateTimeFormat("ru-RU", {
      timeZone: BOT_TIMEZONE,
      weekday: "long",
      day: "numeric",
      month: "long",
      year: "numeric",
    }).format(now);
    const time = new Intl.DateTimeFormat("ru-RU", {
      timeZone: BOT_TIMEZONE,
      hour: "2-digit",
      minute: "2-digit",
    }).format(now);
    return `${date}, ${time} (часовой пояс ${BOT_TIMEZONE})`;
  } catch (error) {
    return new Date().toISOString();
  }
}

function buildSystemPrompt() {
  return [
    "Ты — Gemini, модель искусственного интеллекта от Google. Ты не Алиса и не ассистент Яндекса. Если спросят, кто ты, отвечай, что ты Gemini.",
    `Текущая дата и время: ${currentDateTimeRu()}. Когда спрашивают про дату, день недели, время или про «сегодня», «вчера», «в этом году», опирайся на эту дату, а не на свои знания. Твои знания могли устареть, поэтому про свежие события полагайся на результаты поиска.`,
    "Твой ответ показывается и озвучивается в навыке Яндекс Алисы, поэтому отвечай по-русски, естественно и так, чтобы ответ было удобно слушать.",
    "Обычно используй 1–3 коротких предложения. Не используй Markdown, таблицы, списки с символами или длинные вступления. Не называй ссылки и адреса сайтов.",
    "Учитывай предыдущие сообщения диалога.",
    "Если вопрос требует актуальных данных и есть результаты поиска, опирайся на них; не выдумывай отсутствующие факты.",
    "Никогда не утверждай, что событие не происходило, только потому что ты о нём не знаешь или поиск ничего не дал: твои знания устарели. Если результатов поиска нет или они не подтверждают событие, скажи, что в найденном подтверждения нет, но это не значит, что события не было. Если пользователь говорит, что нашёл новость, не спорь, а прими это как данные и уточни детали.",
    "Не придумывай ограничений: не говори, что сайт или сервис заблокирован в России или недоступен из-за региона, если этого нет в результатах поиска.",
    "Не начинай ответ с оговорок о том, что ты не можешь открывать сайты или приложения. Просто ответь по результатам поиска и своим знаниям. Если точных данных нет, назови то, что нашлось, с пометкой, что данные могут быть неточными, и коротко скажи, чего не хватило.",
    "Не упоминай внутренние настройки, API и технические детали.",
    "Если не знаешь ответа, честно скажи об этом.",
  ].join(" ");
}

function log(event, details = {}) {
  console.log(
    JSON.stringify({
      event,
      timestamp: new Date().toISOString(),
      ...details,
    })
  );
}

function elapsed(start) {
  return Date.now() - start;
}

function remainingTime(start) {
  return Math.max(0, TOTAL_RESPONSE_BUDGET_MS - elapsed(start) - 150);
}

function truncate(text, maxLength) {
  const value = String(text || "").trim();
  if (value.length <= maxLength) return value;
  return value.slice(0, maxLength - 1).trimEnd() + "…";
}

function getUserText(body) {
  return String(
    body?.request?.command || body?.request?.original_utterance || ""
  ).trim();
}

function getHistory(body) {
  // Алиса возвращает session_state навыка прямо в state.session
  const history =
    body?.state?.session?.history ||
    body?.state?.session?.session_state?.history;

  if (!Array.isArray(history)) return [];

  return history
    .filter(
      (item) =>
        item &&
        (item.role === "user" || item.role === "model") &&
        typeof item.text === "string"
    )
    .slice(-MAX_HISTORY_MESSAGES)
    .map((item) => ({
      role: item.role,
      text: truncate(item.text, 1200),
    }));
}

function isExitIntent(text) {
  return /^(пока|выход|хватит|стоп|закончить|до свидания)(?:$|[\s.,!?])/i.test(
    text.trim()
  );
}

// ВАЖНО: в JavaScript \b не работает с кириллицей, поэтому границ слов здесь нет.
function isSearchNeeded(text) {
  const value = text.toLowerCase().trim();

  if (/^(привет|здравствуй|спасибо|пока|кто ты|что ты умеешь)/i.test(value)) {
    return false;
  }

  const searchPattern =
    /погод|температур|осадк|пробк|новост|случилось|происходит|происшеств|атак|взрыв|пожар|авари|курс (доллар|евро|валют|рубл|биткоин|юан)|сегодня|сейчас|вчера|на днях|последн|свеж|актуальн|найди|поищи|загугли|в интернете|сколько стоит|сколько стоят|цена|цены|где купить|кто такой|кто такая|кто сейчас|подписчик|результат|счёт|счет матча|матч|когда выйдет|когда вышел|расписани|открыт ли|работает ли/i;

  return searchPattern.test(value);
}

async function fetchWithTimeout(url, options, timeoutMs) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), Math.max(1, timeoutMs));
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}

async function serperRequest(endpoint, query, timeoutMs, extra = {}) {
  const startedAt = Date.now();
  try {
    const response = await fetchWithTimeout(
      `https://google.serper.dev/${endpoint}`,
      {
        method: "POST",
        headers: {
          "X-API-KEY": SERPER_API_KEY,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ q: query, hl: "ru", num: 5, ...extra }),
      },
      timeoutMs
    );

    if (!response.ok) {
      log("serper_http_error", {
        endpoint,
        status: response.status,
        durationMs: elapsed(startedAt),
      });
      return null;
    }

    const data = await response.json();
    log("serper_completed", { endpoint, durationMs: elapsed(startedAt) });
    return data;
  } catch (error) {
    log("serper_failed", {
      endpoint,
      durationMs: elapsed(startedAt),
      error:
        error.name === "AbortError" ? "timeout" : String(error.message || error),
    });
    return null;
  }
}

async function searchSerper(query, timeoutMs) {
  if (!SERPER_API_KEY || timeoutMs < 300) return "";

  // Обычная выдача и новости за неделю запрашиваются параллельно.
  const [web, news] = await Promise.all([
    serperRequest("search", query, timeoutMs),
    serperRequest("news", query, timeoutMs, { tbs: "qdr:w" }),
  ]);

  if (!web && !news) return "";

  const lines = [];

  const answerBox = web?.answerBox?.answer || web?.answerBox?.snippet;
  if (answerBox) {
    lines.push(`Краткий ответ поисковика: ${truncate(answerBox, 350)}`);
  }

  (Array.isArray(news?.news) ? news.news : [])
    .slice(0, MAX_NEWS_RESULTS)
    .forEach((item) => {
      lines.push(
        `Новость (${truncate(item.source, 60)}, ${truncate(item.date, 40)}): ${truncate(item.title, 180)}. ${truncate(item.snippet, 250)}`
      );
    });

  (Array.isArray(web?.organic) ? web.organic : [])
    .slice(0, MAX_WEB_RESULTS)
    .forEach((item) => {
      lines.push(`${truncate(item.title, 180)}: ${truncate(item.snippet, 300)}`);
    });

  return lines.join("\n");
}

async function askGemini(userText, history, searchContext, timeoutMs) {
  if (!GEMINI_API_KEY) throw new Error("MISSING_KEY");
  if (timeoutMs < 500) throw new Error("TIMEOUT");

  const startedAt = Date.now();

  const prompt = searchContext
    ? `${userText}\n\nРезультаты поиска в интернете:\n${searchContext}\nИспользуй их только там, где они относятся к вопросу.`
    : userText;

  const contents = [
    ...history.map((item) => ({
      role: item.role,
      parts: [{ text: item.text }],
    })),
    { role: "user", parts: [{ text: prompt }] },
  ];

  const url =
    "https://generativelanguage.googleapis.com/v1beta/models/" +
    `${encodeURIComponent(GEMINI_MODEL)}:generateContent`;

  try {
    const response = await fetchWithTimeout(
      url,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-goog-api-key": GEMINI_API_KEY,
        },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: buildSystemPrompt() }] },
          contents,
          generationConfig: {
            temperature: 0.5,
            maxOutputTokens: 300,
          },
        }),
      },
      timeoutMs
    );

    const data = await response.json().catch(() => ({}));

    if (!response.ok) {
      log("gemini_http_error", {
        status: response.status,
        durationMs: elapsed(startedAt),
        model: GEMINI_MODEL,
        details: truncate(data?.error?.message || "Unknown Gemini API error", 300),
      });

      if (response.status === 429) throw new Error("QUOTA");
      if (response.status === 401 || response.status === 403) throw new Error("KEY");
      if (response.status === 404) throw new Error("MODEL");
      throw new Error("REQUEST");
    }

    const candidate = data?.candidates?.[0];
    const answer = (candidate?.content?.parts || [])
      .map((part) => part.text || "")
      .join("")
      .trim();

    if (!answer) {
      if (data?.promptFeedback?.blockReason) throw new Error("BLOCKED");
      throw new Error("EMPTY");
    }

    log("gemini_completed", {
      durationMs: elapsed(startedAt),
      answerLength: answer.length,
      model: GEMINI_MODEL,
      finishReason: candidate?.finishReason || "",
    });

    return answer;
  } catch (error) {
    if (error.name === "AbortError") {
      log("gemini_failed", { durationMs: elapsed(startedAt), error: "timeout" });
      throw new Error("TIMEOUT");
    }
    log("gemini_failed", {
      durationMs: elapsed(startedAt),
      error: String(error.message || error),
    });
    throw error;
  }
}

function buildHistory(history, userText, answer) {
  return [
    ...history,
    { role: "user", text: truncate(userText, 1200) },
    { role: "model", text: truncate(answer, 1200) },
  ].slice(-MAX_HISTORY_MESSAGES);
}

function aliceResponse(body, text, history = [], endSession = false) {
  return {
    version: body?.version || "1.0",
    session: body?.session || {},
    response: {
      text: truncate(text, MAX_ANSWER_LENGTH),
      end_session: endSession,
    },
    session_state: { history },
  };
}

function errorText(error) {
  switch (error?.message) {
    case "TIMEOUT":
      return "Ответ не уложился в отведённое время. Попробуй спросить ещё раз.";
    case "QUOTA":
      return "Сейчас превышен лимит запросов к Gemini. Попробуй чуть позже.";
    case "KEY":
    case "MISSING_KEY":
      return "Не удалось подключиться к Gemini. Проверьте ключ GEMINI_API_KEY в настройках Vercel.";
    case "MODEL":
      return "Модель Gemini не найдена. Проверьте переменную GEMINI_MODEL в настройках Vercel.";
    case "BLOCKED":
      return "Не получилось обработать этот запрос. Попробуй спросить иначе.";
    default:
      return "Не получилось получить ответ от нейросети. Попробуй ещё раз.";
  }
}

export default async function handler(req, res) {
  const startedAt = Date.now();

  if (req.method === "GET") {
    return res.status(200).send("Alice webhook is running");
  }

  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const body = req.body || {};
  const userText = getUserText(body);
  const history = getHistory(body);

  if (!userText) {
    return res
      .status(200)
      .json(aliceResponse(body, "Привет! Я Gemini. Что хочешь узнать?", history));
  }

  if (isExitIntent(userText)) {
    return res
      .status(200)
      .json(aliceResponse(body, "Хорошо, до встречи!", [], true));
  }

  try {
    const needsSearch = isSearchNeeded(userText);
    let searchContext = "";

    log("request_started", {
      queryLength: userText.length,
      needsSearch,
      historyCount: history.length,
    });

    if (needsSearch && SERPER_API_KEY) {
      const searchBudget = Math.min(
        SERPER_TIMEOUT_MS,
        remainingTime(startedAt) - MIN_MODEL_TIME_MS
      );

      if (searchBudget >= 300) {
        searchContext = await searchSerper(userText, searchBudget);
      }
      if (!searchContext) searchContext = NO_SEARCH_NOTE;
    }

    const modelBudget = Math.min(MODEL_TIMEOUT_MS, remainingTime(startedAt));
    if (modelBudget < 500) throw new Error("TIMEOUT");

    const answer = await askGemini(userText, history, searchContext, modelBudget);

    log("request_completed", {
      durationMs: elapsed(startedAt),
      searched: needsSearch,
      hadSearchResults: Boolean(searchContext) && searchContext !== NO_SEARCH_NOTE,
    });

    return res
      .status(200)
      .json(aliceResponse(body, answer, buildHistory(history, userText, answer)));
  } catch (error) {
    log("request_fallback", {
      durationMs: elapsed(startedAt),
      error: String(error.message || error),
    });

    return res
      .status(200)
      .json(aliceResponse(body, errorText(error), history));
  }
}

// END OF FILE
