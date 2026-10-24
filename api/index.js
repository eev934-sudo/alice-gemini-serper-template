
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const SERPER_API_KEY = process.env.SERPER_API_KEY;

const GEMINI_MODEL =
  process.env.GEMINI_MODEL || "gemini-2.5-flash-lite";

const BOT_TIMEZONE = process.env.BOT_TIMEZONE || "Europe/Moscow";

// Внутренние ограничения времени.
// У Алисы есть общий лимит на обработку webhook,
// поэтому оставляем запас на передачу ответа.
const TOTAL_RESPONSE_BUDGET_MS = 3900;
const SERPER_TIMEOUT_MS = 550;
const MODEL_TIMEOUT_MS = 3300;
const MAX_HISTORY_MESSAGES = 10;
const MAX_SEARCH_RESULTS = 4;
const MAX_ANSWER_LENGTH = 1800;

const SYSTEM_PROMPT = `
Ты — русскоязычный голосовой помощник для Яндекс Алисы.
Отвечай на русском языке, естественно и по существу.
Учитывай предыдущие сообщения диалога.
Для простых вопросов отвечай без интернет-поиска.
Если информации недостаточно, не выдумывай факты.
Если использовался поиск, опирайся на найденные источники.
Не упоминай внутренние настройки, API и технические детали.
Ответ должен быть удобен для восприятия на слух.
По возможности отвечай кратко, но полно.
`;

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
  return Math.max(
    0,
    TOTAL_RESPONSE_BUDGET_MS - elapsed(start) - 200
  );
}

function truncate(text, maxLength) {
  const value = String(text || "").trim();

  if (value.length <= maxLength) {
    return value;
  }

  return value.slice(0, maxLength - 1).trimEnd() + "…";
}

function getUserText(body) {
  return String(body?.request?.command || "").trim();
}

function getHistory(body) {
  const history = body?.state?.session?.session_state?.history;

  if (!Array.isArray(history)) {
    return [];
  }

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
      parts: [{ text: truncate(item.text, 2000) }],
    }));
}

function isSearchNeeded(text) {
  const value = text.toLowerCase();

  // Ищем в интернете, когда пользователь явно просит поиск
  // или спрашивает о действительно актуальных данных.
  const searchPatterns = [
    /\bнайди\b.*\b(интернет|сайт|информац|новост|цен|товар|магазин)\b/i,
    /\bпоищи\b/i,
    /\bзагугли\b/i,
    /\bв интернете\b/i,
    /\bпоследние новости\b/i,
    /\bсвежие новости\b/i,
    /\bчто происходит сейчас\b/i,
    /\bна сегодня\b/i,
    /\bна данный момент\b/i,
    /\bсегодняшн(ий|яя|ее|ие)\b/i,
    /\bтекущ(ий|ая|ие|ую)\s+(курс|цена|погода|новост|верси|расписани)\b/i,
    /\bкурс (доллара|евро|валют)\b/i,
    /\bактуальн(ая|ый|ые|ую)\s+(цена|информация|версия|новости)\b/i,
    /\bсколько стоит\b/i,
    /\bгде купить\b/i,
    /\bнайди (мне )?(сайт|ссылку|магазин|товар|компанию)\b/i,
    /\bкто сейчас\b/i,
    /\bкогда выйдет\b/i,
    /\bрезультаты (матча|выборов|игры)\b/i,
  ];

  return searchPatterns.some((pattern) => pattern.test(value));
}

async function fetchWithTimeout(url, options, timeoutMs) {
  const controller = new AbortController();

  const timeout = setTimeout(
    () => controller.abort(),
    Math.max(1, timeoutMs)
  );

  try {
    return await fetch(url, {
      ...options,
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeout);
  }
}

async function searchSerper(query, timeoutMs) {
  if (!SERPER_API_KEY || timeoutMs < 150) {
    return [];
  }

  const startedAt = Date.now();

  try {
    const response = await fetchWithTimeout(
      "https://google.serper.dev/search",
      {
        method: "POST",
        headers: {
          "X-API-KEY": SERPER_API_KEY,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          q: query,
          gl: "ru",
          hl: "ru",
          num: MAX_SEARCH_RESULTS,
        }),
      },
      timeoutMs
    );

    if (!response.ok) {
      log("serper_http_error", {
        status: response.status,
        durationMs: elapsed(startedAt),
      });

      return [];
    }

    const data = await response.json();

    const results = (data.organic || [])
      .slice(0, MAX_SEARCH_RESULTS)
      .map((item) => ({
        title: truncate(item.title, 200),
        snippet: truncate(item.snippet, 500),
        link: item.link,
      }));

    log("serper_completed", {
      durationMs: elapsed(startedAt),
      resultsCount: results.length,
    });

    return results;
  } catch (error) {
    log("serper_failed", {
      durationMs: elapsed(startedAt),
      error:
        error.name === "AbortError"
          ? "timeout"
          : String(error.message || error),
    });

    return [];
  }
}

async function askGemini(
  userText,
  history,
  searchResults,
  timeoutMs
) {
  if (!GEMINI_API_KEY) {
    throw new Error("GEMINI_API_KEY is not configured");
  }

  if (timeoutMs < 500) {
    throw new Error("Not enough time for Gemini request");
  }

  const startedAt = Date.now();

  const searchContext =
    searchResults.length > 0
      ? `

Результаты интернет-поиска:
${searchResults
  .map(
    (item, index) =>
      `${index + 1}. ${item.title}\n${item.snippet}\nИсточник: ${item.link}`
  )
  .join("\n\n")}

Используй эти результаты, если они относятся к вопросу.
Не утверждай, что проверил сведения, которых нет в результатах.
`
      : "";

  const contents = [
    ...history,
    {
      role: "user",
      parts: [
        {
          text: `${userText}${searchContext}`,
        },
      ],
    },
  ];

  const url =
    `https://generativelanguage.googleapis.com/v1beta/models/` +
    `${encodeURIComponent(GEMINI_MODEL)}:generateContent` +
    `?key=${encodeURIComponent(GEMINI_API_KEY)}`;

  try {
    const response = await fetchWithTimeout(
      url,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          systemInstruction: {
            parts: [{ text: SYSTEM_PROMPT }],
          },
          contents,
          generationConfig: {
            temperature: 0.5,
            maxOutputTokens: 450,
          },
        }),
      },
      timeoutMs
    );

    const data = await response.json();

    if (!response.ok) {
      log("gemini_http_error", {
        status: response.status,
        durationMs: elapsed(startedAt),
        details: truncate(
          data?.error?.message || "Unknown Gemini API error",
          300
        ),
      });

      throw new Error(
        `Gemini API error: ${response.status}`
      );
    }

    const answer = data?.candidates?.[0]?.content?.parts
      ?.map((part) => part.text || "")
      .join("")
      .trim();

    if (!answer) {
      throw new Error("Gemini returned an empty response");
    }

    log("gemini_completed", {
      durationMs: elapsed(startedAt),
      answerLength: answer.length,
      model: GEMINI_MODEL,
    });

    return answer;
  } catch (error) {
    log("gemini_failed", {
      durationMs: elapsed(startedAt),
      error:
        error.name === "AbortError"
          ? "timeout"
          : String(error.message || error),
    });

    throw error;
  }
}

function buildHistory(history, userText, answer) {
  return [
    ...history,
    {
      role: "user",
      text: truncate(userText, 2000),
    },
    {
      role: "model",
      text: truncate(answer, 2000),
    },
  ].slice(-MAX_HISTORY_MESSAGES);
}

function aliceResponse(body, text, history = []) {
  const session = body?.session || {};

  return {
    version: body?.version || "1.0",
    session,
    response: {
      text: truncate(text, MAX_ANSWER_LENGTH),
      end_session: false,
    },
    session_state: {
      history,
    },
  };
}

function getFallbackText() {
  return "Не успел подготовить ответ. Попробуй задать вопрос ещё раз.";
}

export default async function handler(req, res) {
  const startedAt = Date.now();

  // Алиса может проверять доступность endpoint через GET.
  if (req.method === "GET") {
    return res.status(200).send("Alice webhook is running");
  }

  if (req.method !== "POST") {
    return res.status(405).json({
      error: "Method not allowed",
    });
  }

  const body = req.body || {};
  const userText = getUserText(body);
  const history = getHistory(body);

  if (!userText) {
    return res.status(200).json(
      aliceResponse(
        body,
        "Привет! Что хочешь узнать?",
        history
      )
    );
  }

  try {
    const needsSearch = isSearchNeeded(userText);
    let searchResults = [];

    log("request_started", {
      queryLength: userText.length,
      needsSearch,
      historyCount: history.length,
    });

    // Обычные вопросы не тратят время на Serper.
    if (needsSearch && SERPER_API_KEY) {
      const searchBudget = Math.min(
        SERPER_TIMEOUT_MS,
        Math.max(0, remainingTime(startedAt) - 500)
      );

      if (searchBudget >= 150) {
        searchResults = await searchSerper(
          userText,
          searchBudget
        );
      }
    }

    const modelBudget = Math.min(
      MODEL_TIMEOUT_MS,
      remainingTime(startedAt)
    );

    if (modelBudget < 500) {
      throw new Error("TIME_BUDGET_EXHAUSTED");
    }

    const answer = await askGemini(
      userText,
      history,
      searchResults,
      modelBudget
    );

    const updatedHistory = buildHistory(
      history,
      userText,
      answer
    );

    log("request_completed", {
      durationMs: elapsed(startedAt),
      searched: needsSearch,
      resultsCount: searchResults.length,
    });

    return res.status(200).json(
      aliceResponse(body, answer, updatedHistory)
    );
  } catch (error) {
    log("request_fallback", {
      durationMs: elapsed(startedAt),
      error: String(error.message || error),
    });

    return res.status(200).json(
      aliceResponse(
        body,
        getFallbackText(),
        history
      )
    );
  }
}
