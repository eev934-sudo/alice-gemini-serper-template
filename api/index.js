const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const SERPER_API_KEY = process.env.SERPER_API_KEY;

const GEMINI_MODEL = process.env.GEMINI_MODEL || "gemini-3.5-flash-lite";
const GEMINI_THINKING_LEVEL = String(process.env.GEMINI_THINKING_LEVEL || "").trim();
const BOT_TIMEZONE = process.env.BOT_TIMEZONE || "Europe/Moscow";

// Лимит Алисы для навыка — 4,5 с на всё (доставка запроса, работа, доставка ответа).
// Держим запас, чтобы даже аварийный ответ успел дойти.
const TOTAL_RESPONSE_BUDGET_MS = 3900;
const SERPER_TIMEOUT_MS = 1200;
const MIN_MODEL_TIME_MS = 1800;
const MODEL_TIMEOUT_MS = 3500;
const HEDGE_DELAY_MS = 1500;
const MIN_HEDGE_TIME_MS = 700;
const REWRITE_TIMEOUT_MS = 900;
const MAX_HISTORY_MESSAGES = 6;
const MAX_NEWS_RESULTS = 4;
const MAX_WEB_RESULTS = 4;
const MAX_ANSWER_LENGTH = 1000;
// ИЗМЕНЕНО: токены «размышлений» тоже считаются в maxOutputTokens.
// При 200 модель могла «додумать» до лимита и вернуть пустой или обрезанный ответ.
const MAX_OUTPUT_TOKENS = Number(process.env.GEMINI_MAX_OUTPUT_TOKENS) || 400;

const NO_SEARCH_NOTE =
  "ПОИСК НЕ ДАЛ РЕЗУЛЬТАТОВ ИЛИ НЕ УСПЕЛ ОТВЕТИТЬ. Свежих данных нет: скажи об этом прямо, ответь только на основе того, что точно знаешь, и не отрицай события, о которых не знаешь.";

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

function currentYear() {
  try {
    return new Intl.DateTimeFormat("ru-RU", {
      timeZone: BOT_TIMEZONE,
      year: "numeric",
    }).format(new Date());
  } catch (error) {
    return String(new Date().getFullYear());
  }
}

function buildSystemPrompt() {
  return [
    "Ты — Gemini, модель искусственного интеллекта от Google. Ты не Алиса и не ассистент Яндекса. Если спросят, кто ты, отвечай, что ты Gemini.",
    `Текущая дата и время: ${currentDateTimeRu()}. Когда спрашивают про дату, день недели, время или про «сегодня», «вчера», «в этом году», опирайся на эту дату, а не на свои знания. Твои знания могли устареть, поэтому про свежие события полагайся на результаты поиска.`,
    "Твой ответ показывается и озвучивается в навыке Яндекс Алисы, поэтому отвечай по-русски, естественно и так, чтобы ответ было удобно слушать.",
    "Обычно используй 1–3 коротких предложения. Не используй Markdown, таблицы, списки с символами или длинные вступления. Не называй ссылки и адреса сайтов.",
    "Учитывай предыдущие сообщения диалога.",
    "Отвечай прямо и по существу на любые вопросы, включая политику, спорные и острые темы. Называй факты, цифры и даты из результатов поиска и указывай источник по названию, например «по данным РБК». Различай установленные факты, оценки и заявления сторон.",
    "Если источники расходятся, прямо назови расхождение. Не выдавай предположения за факты.",
    "Если в результатах поиска есть и старые, и свежие сведения по одному вопросу, опирайся на самые свежие и называй их дату, если она указана.",
    "Не уходи от ответа общими фразами вроде «в открытых источниках не представлено». Если данных нет, скажи, что именно искал и чего не нашёл. Не утверждай, что событие не происходило, только потому что ты о нём не знаешь или поиск ничего не дал: твои знания устарели.",
    "Если пользователь говорит, что нашёл новость, не спорь, а прими это как данные и уточни детали.",
    "Не придумывай ограничений: не говори, что сайт или сервис заблокирован в России или недоступен из-за региона, если этого нет в результатах поиска.",
    "Не начинай ответ с оговорок о том, что ты не можешь открывать сайты или приложения. Просто ответь по результатам поиска и своим знаниям.",
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

// ИЗМЕНЕНО: логика перевёрнута. Раньше искали только по списку слов или для фраз
// от 4 слов, и короткие вопросы вроде «что с биткоином» уходили без поиска.
// Теперь ищем по умолчанию, кроме явной болтовни, творческих задач и арифметики.
const NO_SEARCH_PATTERN =
  /^(привет|здравствуй|добрый (день|вечер|утро)|доброе утро|спасибо|благодарю|кто ты|что ты умеешь|как дела|как тебя зовут|расскажи (анекдот|шутку|сказку|стих)|придумай|сочини|напиши|переведи|посчитай|сколько будет|\d+\s*[+\-*/×÷x]\s*\d+)/i;

function isSearchNeeded(text) {
  const value = text.toLowerCase().trim();
  if (!value) return false;
  return !NO_SEARCH_PATTERN.test(value);
}

// Запросы, для которых нужна лента новостей (за неделю).
const NEWS_PATTERN =
  /новост|случилось|происходит|происшеств|атак|взрыв|пожар|авари|обстрел|вчера|сегодня|на днях|последн|свеж|только что|что с |что там|итог|результат|выбор|голосован|референдум|победил|выиграл|санкци|матч|счёт|счет/i;

// Убираем вводные слова из разговорной фразы и при необходимости добавляем год,
// чтобы поисковик находил свежее.
function cleanSearchQuery(text) {
  let query = String(text || "")
    .toLowerCase()
    .replace(/[?!.,;:]+/g, " ")
    .replace(
      /(^|\s)(алиса|слушай|скажи|подскажи|расскажи|пожалуйста|мне|ну|а|вот|можешь|можно|хочу узнать|интересно)(?=\s|$)/g,
      " "
    )
    .replace(/\s{2,}/g, " ")
    .trim();

  if (!query) query = String(text || "").trim();

  const wantsFresh = /итог|результат|выбор|голосован|матч|счёт|счет|победил|выиграл|рейтинг|новост/i.test(query);
  if (wantsFresh && !/20\d\d/.test(query)) {
    query = `${query} ${currentYear()}`;
  }

  return query;
}

// ИЗМЕНЕНО: учитываем контекст диалога. Реплики вроде «а в Москве?» или «что дальше?»
// сами по себе ничего не значат для поисковика, поэтому дописываем предыдущий вопрос.
const FOLLOW_UP_PATTERN =
  /(^|\s)(он|она|оно|они|его|её|ее|их|ему|ей|им|там|тогда|потом|дальше|этот|эта|эти|тот|та|те|такой|такая)(?=\s|$)/;

function buildSearchQuery(text, history) {
  const base = cleanSearchQuery(text);
  const wordCount = base.split(/\s+/).filter(Boolean).length;
  const looksLikeFollowUp =
    wordCount <= 3 || FOLLOW_UP_PATTERN.test(base) || /^(а|и)\s/i.test(text.trim());

  if (looksLikeFollowUp) {
    const lastUser = [...history].reverse().find((item) => item.role === "user");
    if (lastUser) {
      const previous = cleanSearchQuery(lastUser.text);
      if (previous && !base.includes(previous)) {
        return truncate(`${previous} ${base}`, 200);
      }
    }
  }

  return base;
}

// ИЗМЕНЕНО: окно для новостей зависит от вопроса. Раньше всегда была неделя,
// и вопросы про события месячной давности («допустили ли партию на выборы»)
// оставались без новостей. Если пользователь явно просит свежее, берём неделю,
// иначе год: модель сама выберет самое свежее по датам.
function newsTimeWindow(text) {
  if (/сегодня|вчера|сейчас|только что|на днях|последн|свеж/i.test(text)) {
    return "qdr:w";
  }
  return "qdr:y";
}

// ИЗМЕНЕНО: короткий запрос к Gemini, который превращает разговорную реплику
// в нормальный поисковый запрос с учётом контекста. Если не уложился в время,
// используется запасной вариант из buildSearchQuery.
async function rewriteSearchQuery(userText, history, timeoutMs) {
  if (!GEMINI_API_KEY || timeoutMs < 400) return "";

  const startedAt = Date.now();
  const dialog = history
    .slice(-4)
    .map(
      (item) =>
        `${item.role === "user" ? "Пользователь" : "Ассистент"}: ${truncate(item.text, 300)}`
    )
    .join("\n");

  const instruction = [
    `Сегодня ${currentDateTimeRu()}.`,
    "Преврати последнюю реплику пользователя в короткий поисковый запрос для Google: 3–8 слов, только ключевые слова, без вводных слов.",
    "Учитывай контекст диалога: если реплика неполная («а в Москве?», «и что дальше?»), восстанови недостающее из предыдущих сообщений.",
    "Если вопрос про события этого года, добавь год. Названия, имена и партии пиши так, как их пишут в новостях.",
    "Верни только сам запрос одной строкой, без кавычек и пояснений.",
  ].join(" ");

  const generationConfig = { temperature: 0, maxOutputTokens: 120 };
  if (GEMINI_THINKING_LEVEL) {
    generationConfig.thinkingConfig = { thinkingLevel: GEMINI_THINKING_LEVEL };
  }

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
          systemInstruction: { parts: [{ text: instruction }] },
          contents: [
            {
              role: "user",
              parts: [
                { text: `${dialog ? dialog + "\n" : ""}Пользователь: ${userText}` },
              ],
            },
          ],
          generationConfig,
        }),
      },
      timeoutMs
    );

    if (!response.ok) {
      log("query_rewrite_http_error", {
        status: response.status,
        durationMs: elapsed(startedAt),
      });
      return "";
    }

    const data = await response.json();
    const raw = (data?.candidates?.[0]?.content?.parts || [])
      .map((part) => part.text || "")
      .join("")
      .trim();

    const query = raw
      .split("\n")[0]
      .replace(/^["«»'\s]+|["«»'\s]+$/g, "")
      .trim();

    if (!query || query.length > 200) return "";

    log("query_rewritten", { durationMs: elapsed(startedAt), query });
    return query;
  } catch (error) {
    log("query_rewrite_failed", {
      durationMs: elapsed(startedAt),
      error:
        error.name === "AbortError" ? "timeout" : String(error.message || error),
    });
    return "";
  }
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

// ИЗМЕНЕНО: новости подмешиваем только для новостных запросов. Раньше они шли
// в каждый запрос и засоряли ответы на вопросы вроде «кто такой …».
// Также добавлена справка из knowledgeGraph.
async function searchSerper(query, timeoutMs, includeNews, newsWindow = "qdr:y") {
  if (!SERPER_API_KEY || timeoutMs < 300) return "";

  const [web, news] = await Promise.all([
    serperRequest("search", query, timeoutMs),
    includeNews
      ? serperRequest("news", query, timeoutMs, { tbs: newsWindow })
      : Promise.resolve(null),
  ]);

  if (!web && !news) return "";

  const lines = [];

  const answerBox = web?.answerBox?.answer || web?.answerBox?.snippet;
  if (answerBox) {
    lines.push(`Краткий ответ поисковика: ${truncate(answerBox, 350)}`);
  }

  const kg = web?.knowledgeGraph;
  if (kg?.description) {
    lines.push(`Справка (${truncate(kg.title, 80)}): ${truncate(kg.description, 300)}`);
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
      const date = item.date ? ` (${truncate(item.date, 40)})` : "";
      lines.push(`${truncate(item.title, 180)}${date}: ${truncate(item.snippet, 300)}`);
    });

  return lines.join("\n");
}

async function askGemini(userText, history, searchContext, timeoutMs) {
  if (!GEMINI_API_KEY) throw new Error("MISSING_KEY");
  if (timeoutMs < 500) throw new Error("TIMEOUT");

  const startedAt = Date.now();

  // ИЗМЕНЕНО: результаты поиска идут перед вопросом, а не после него,
  // и явно помечены как актуальные на сегодня.
  const prompt = searchContext
    ? `Результаты поиска в интернете (актуальны на сегодня):\n${searchContext}\n\nВопрос пользователя: ${userText}\n\nОтветь на вопрос, опираясь на результаты поиска там, где они относятся к вопросу. Если в результатах есть прямой ответ, скажи его в первом же предложении.`
    : userText;

  const contents = [
    ...history.map((item) => ({
      role: item.role,
      parts: [{ text: item.text }],
    })),
    { role: "user", parts: [{ text: prompt }] },
  ];

  const generationConfig = {
    temperature: 0.4,
    maxOutputTokens: MAX_OUTPUT_TOKENS,
  };
  if (GEMINI_THINKING_LEVEL) {
    generationConfig.thinkingConfig = { thinkingLevel: GEMINI_THINKING_LEVEL };
  }

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
          generationConfig,
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
        thinkingLevel: GEMINI_THINKING_LEVEL || "default",
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
      log("gemini_blocked", {
        blockReason: data?.promptFeedback?.blockReason || "",
        finishReason: candidate?.finishReason || "",
        thoughtsTokens: data?.usageMetadata?.thoughtsTokenCount,
        model: GEMINI_MODEL,
      });
      if (data?.promptFeedback?.blockReason) throw new Error("BLOCKED");
      throw new Error("EMPTY");
    }

    log("gemini_completed", {
      durationMs: elapsed(startedAt),
      answerLength: answer.length,
      model: GEMINI_MODEL,
      thinkingLevel: GEMINI_THINKING_LEVEL || "default",
      finishReason: candidate?.finishReason || "",
      promptTokens: data?.usageMetadata?.promptTokenCount,
      answerTokens: data?.usageMetadata?.candidatesTokenCount,
      thoughtsTokens: data?.usageMetadata?.thoughtsTokenCount,
    });

    return answer;
  } catch (error) {
    if (error.name === "AbortError") {
      log("gemini_failed", {
        durationMs: elapsed(startedAt),
        error: "timeout",
        timeoutBudgetMs: timeoutMs,
        model: GEMINI_MODEL,
      });
      throw new Error("TIMEOUT");
    }
    log("gemini_failed", {
      durationMs: elapsed(startedAt),
      error: String(error.message || error),
    });
    throw error;
  }
}

// Если первый запрос к Gemini не вернулся за HEDGE_DELAY_MS, параллельно
// стартует второй, и берётся тот ответ, который придёт раньше.
function askGeminiHedged(userText, history, searchContext, timeoutMs) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let failures = 0;
    let total = 1;
    let timer = null;

    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      fn(value);
    };

    const run = (budgetMs) => {
      askGemini(userText, history, searchContext, budgetMs)
        .then((answer) => finish(resolve, answer))
        .catch((error) => {
          failures += 1;
          if (failures >= total) finish(reject, error);
        });
    };

    run(timeoutMs);

    if (timeoutMs - HEDGE_DELAY_MS >= MIN_HEDGE_TIME_MS) {
      timer = setTimeout(() => {
        if (settled) return;
        total = 2;
        log("gemini_hedge_started", { afterMs: HEDGE_DELAY_MS });
        run(timeoutMs - HEDGE_DELAY_MS);
      }, HEDGE_DELAY_MS);
    }
  });
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
      return "Google заблокировал ответ на этот запрос. Попробуй сформулировать иначе.";
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
      // Запасной вариант запроса, если переписывание не успеет.
      let searchQuery = buildSearchQuery(userText, history);

      const rewriteBudget = Math.min(
        REWRITE_TIMEOUT_MS,
        remainingTime(startedAt) - MIN_MODEL_TIME_MS - 700
      );
      if (rewriteBudget >= 400) {
        const rewritten = await rewriteSearchQuery(userText, history, rewriteBudget);
        if (rewritten) searchQuery = rewritten;
      }

      const searchBudget = Math.min(
        SERPER_TIMEOUT_MS,
        remainingTime(startedAt) - MIN_MODEL_TIME_MS
      );

      if (searchBudget >= 300) {
        const includeNews = NEWS_PATTERN.test(`${userText} ${searchQuery}`.toLowerCase());
        const newsWindow = newsTimeWindow(userText);
        // Для отладки: видно, что реально ушло в поисковик.
        log("search_query", { searchQuery, includeNews, newsWindow });

        searchContext = await searchSerper(searchQuery, searchBudget, includeNews, newsWindow);
        log("search_result", { chars: searchContext.length });
      }
      if (!searchContext) searchContext = NO_SEARCH_NOTE;
    }

    const modelBudget = Math.min(MODEL_TIMEOUT_MS, remainingTime(startedAt));
    if (modelBudget < 500) throw new Error("TIMEOUT");

    const answer = await askGeminiHedged(userText, history, searchContext, modelBudget);

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
