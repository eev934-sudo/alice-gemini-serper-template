const DEFAULT_GEMINI_MODEL = "gemini-3.5-flash-lite";
const DEFAULT_OPENAI_MODEL = "gpt-4o-mini";
const DEFAULT_ANTHROPIC_MODEL = "claude-haiku-5-5";
const MAX_HISTORY_MESSAGES = 4;
const MAX_HISTORY_MESSAGE_CHARS = 1200;
const MAX_ALICE_TEXT = 1024;
const TOTAL_RESPONSE_BUDGET_MS = 4500;
const SERPER_TIMEOUT_MS = 1000;
const MODEL_TIMEOUT_MS = 4000;
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
      timeZone: tz,
      weekday: "long",
      day: "numeric",
      month: "long",
      year: "numeric"
    }).format(now);
    const time = new Intl.DateTimeFormat("ru-RU", {
      timeZone: tz,
      hour: "2-digit",
      minute: "2-digit"
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
  if (/^(привет|здравствуй|спасибо|пока|хватит|стоп|кто ты|что ты умеешь)/i.test(t)) {
    return false;
  }
  return t.split(/\s+/).length >= 3;
}

function isExitIntent(text) {
  return /^(пока|выход|хватит|стоп|закончить|до свидания)(?:$|[\s.,!?])/i.test(text.trim());
}

function safeHistory(history) {
  if (!Array.isArray(history)) return [];
  return history
    .filter(item =>
      item &&
      (item.role === "user" || item.role === "model") &&
      typeof item.text === "string"
    )
    .slice(-MAX_HISTORY_MESSAGES)
    .map(item => ({
      role: item.role,
      text: item.text.slice(0, MAX_HISTORY_MESSAGE_CHARS)
    }));
}

async function fetchJson(url, options, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(100, timeoutMs));

  try {
    const response = await fetch(url, {
      ...options,
      signal: controller.signal
    });
    const data = await response.json().catch(() => ({}));
    return { response, data };
  } finally {
    clearTimeout(timer);
  }
}

async function serperQuery(endpoint, query, timeoutMs, extra = {}) {
  const key = process.env.SERPER_API_KEY;

  try {
    const { response, data } = await fetchJson(
      `https://google.serper.dev/${endpoint}`,
      {
        method: "POST",
        headers: {
          "X-API-KEY": key,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          q: query,
          hl: "ru",
          num: 5,
          ...extra
        })
      },
      timeoutMs
    );

    if (!response.ok) {
      console.warn("Serper", endpoint, "failed with HTTP", response.status);
      return null;
    }

    return data;
  } catch (error) {
    return null;
  }
}

async function searchWeb(query, timeoutMs) {
  const key = process.env.SERPER_API_KEY;
  if (!key || timeoutMs < 150) return "";

  const budget = Math.min(SERPER_TIMEOUT_MS, timeoutMs);

  const [web, news] = await Promise.all([
    serperQuery("search", query, budget),
    serperQuery("news", query, budget, { tbs: "qdr:w" })
  ]);

  if (!web && !news) {
    console.warn("Serper request did not finish in time; continuing without search.");
    return "";
  }

  const lines = [];

  const answerBox = web?.answerBox?.answer || web?.answerBox?.snippet;
  if (answerBox) {
    lines.push(`Краткий ответ поисковика: ${String(answerBox).slice(0, 350)}`);
  }

  (Array.isArray(news?.news) ? news.news : []).slice(0, 4).forEach(item => {
    const title = String(item.title || "").slice(0, 180);
    const snippet = String(item.snippet || "").slice(0, 250);
    const source = String(item.source || "").slice(0, 60);
    const date = String(item.date || "").slice(0, 40);
    lines.push(`Новость (${source}, ${date}): ${title}. ${snippet}`.trim());
  });

  (Array.isArray(web?.organic) ? web.organic : []).slice(0, 4).forEach(item => {
    const title = String(item.title || "").slice(0, 180);
    const snippet = String(item.snippet || "").slice(0, 300);
    lines.push(`${title}: ${snippet}`.trim());
  });

  return lines.join("\n");
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

  while (result.length && result[0].role !== "user") {
    result.shift();
  }

  return result;
}

async function askClaude(text, history, searchContext, timeoutMs) {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) throw new Error("MISSING_ANTHROPIC_KEY");
  if (timeoutMs < 250) throw new Error("TIME_BUDGET_EXHAUSTED");

  const model = String(
    process.env.ANTHROPIC_MODEL || DEFAULT_ANTHROPIC_MODEL
  ).trim();

  if (!/^[A-Za-z0-9._:-]+$/.test(model)) {
    throw new Error("INVALID_MODEL_NAME");
  }

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
        messages: toClaudeMessages(
          history,
          buildPrompt(text, searchContext)
        )
      })
    },
    Math.min(MODEL_TIMEOUT_MS, timeoutMs)
  );

  if (!response.ok) {
    const status = Number(response.status);
    console.error(
      "Anthropic request failed with HTTP",
      status,
      data?.error?.message || ""
    );

    if (status === 401 || status === 403) throw new Error("ANTHROPIC_KEY_REJECTED");
    if (status === 404) throw new Error("ANTHROPIC_MODEL_NOT_FOUND");
    if (status === 429) throw new Error("MODEL_QUOTA");

    throw new Error("ANTHROPIC_REQUEST_FAILED");
  }

  const answer = (Array.isArray(data?.content) ? data.content : [])
    .map(part =>
      part?.type === "text" && typeof part.text === "string"
        ? part.text
        : ""
    )
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

  const model = String(
    process.env.OPENAI_MODEL || DEFAULT_OPENAI_MODEL
  ).trim();

  if (!/^[A-Za-z0-9._:-]+$/.test(model)) {
    throw new Error("INVALID_MODEL_NAME");
  }

  const messages = [
    {
      role: "system",
      content: buildSystemPrompt()
    },
    ...safeHistory(history).map(item => ({
      role: item.role === "model" ? "assistant" : "user",
      content: item.text
    })),
    {
      role: "user",
      content: buildPrompt(text, searchContext)
    }
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
    console.error(
      "OpenAI request failed with HTTP",
      status,
      data?.error?.message || ""
    );

    if (status === 401 || status === 403) throw new Error("OPENAI_KEY_REJECTED");
    if (status === 404) throw new Error("OPENAI_MODEL_NOT_FOUND");
    if (status === 429) throw new Error("MODEL_QUOTA");

    throw new Error("OPENAI_REQUEST_FAILED");
  }

  const choice = data?.choices?.[0];
  const answer = String(choice?.message?.content || "").trim();

  if (!answer) {
    if (
      choice?.message?.refusal ||
      choice?.finish_reason === "content_filter"
    ) {
      throw new Error("MODEL_BLOCKED");
    }

    throw new Error("MODEL_EMPTY_RESPONSE");
  }

  if (choice?.finish_reason === "length") {
    console.warn("OpenAI reached the output token limit.");
  }

  return answer;
}

async function askGemini(text, history, searchContext, timeoutMs, grounding = false) {
  const key = process.env.GEMINI_API_KEY;
  if (!key) throw new Error("MISSING_GEMINI_KEY");
  if (timeoutMs < 250) throw new Error("TIME_BUDGET_EXHAUSTED");

  const model = String(
    process.env.GEMINI_MODEL || DEFAULT_GEMINI_MODEL
  ).trim();

  if (!/^[A-Za-z0-9._-]+$/.test(model)) {
    throw new Error("INVALID_MODEL_NAME");
  }

  const contents = safeHistory(history).map(item => ({
    role: item.role,
    parts: [{ text: item.text }]
  }));

  contents.push({
    role: "user",
    parts: [{
      text: buildPrompt(text, searchContext)
    }]
  });

  const requestBody = {
    systemInstruction: {
      parts: [{
        text: buildSystemPrompt()
      }]
    },
    contents,
    generationConfig: {
      temperature: 0.5,
      maxOutputTokens: grounding ? 320 : 200
    }
  };

  if (grounding) {
    requestBody.tools = [{ google_search: {} }];
  }

  const { response, data } = await fetchJson(
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-goog-api-key": key
      },
      body: JSON.stringify(requestBody)
    },
    timeoutMs
  );

  if (!response.ok) {
    const status = Number(response.status);
    console.error(
      "Gemini request failed with HTTP",
      status,
      data?.error?.message || ""
    );

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
    return res.status(405).json({
      error: "Method not allowed"
    });
  }

  const startedAt = Date.now();
  const remainingMs = () => TOTAL_RESPONSE_BUDGET_MS - (Date.now() - startedAt);

  const body = req.body && typeof req.body === "object" ? req.body : {};
  const text = String(
    body?.request?.command ||
    body?.request?.original_utterance ||
    ""
  ).trim();

  const oldHistory = safeHistory(body?.state?.session?.history);

  if (!text) {
    return res.status(200).json(
      aliceResponse(
        `Привет! Я ${providerInfo().name}. Могу ответить на вопрос или найти актуальную информацию. Что хочешь узнать?`,
        false,
        oldHistory
      )
    );
  }

  if (isExitIntent(text)) {
    return res.status(200).json(
      aliceResponse("Хорошо, до встречи!", true, [])
    );
  }

  try {
    const wantsSearch = isSearchIntent(text);
    const useGrounding = wantsSearch && groundingEnabled();
    let searchContext = "";

    if (wantsSearch && !useGrounding && process.env.SERPER_API_KEY) {
      searchContext = await searchWeb(
        text,
        Math.min(
          SERPER_TIMEOUT_MS,
          Math.max(0, remainingMs() - 3800)
        )
      );

      if (!searchContext) {
        searchContext = "ПОИСК НЕ ДАЛ РЕЗУЛЬТАТОВ ИЛИ НЕ УСПЕЛ ОТВЕТИТЬ. Свежих данных нет, отвечай осторожно и не отрицай события.";
      }
    }

    const reserveMs = 300;
    const limitMs = useGrounding
      ? GROUNDED_MODEL_TIMEOUT_MS
      : MODEL_TIMEOUT_MS;

    const timeoutMs = Math.max(
      0,
      Math.min(limitMs, remainingMs() - reserveMs)
    );

    let answer;

    if (process.env.ANTHROPIC_API_KEY) {
      answer = await askClaude(text, oldHistory, searchContext, timeoutMs);
    } else if (process.env.OPENAI_API_KEY) {
      answer = await askOpenAI(text, oldHistory, searchContext, timeoutMs);
    } else {
      answer = await askGemini(
        text,
        oldHistory,
        searchContext,
        timeoutMs,
        useGrounding
      );
    }

    if (useGrounding) {
      console.log(
        "Answered with Gemini Google Search grounding in",
        Date.now() - startedAt,
        "ms"
      );
    }

    const history = [
      ...oldHistory,
      {
        role: "user",
        text: text.slice(0, MAX_HISTORY_MESSAGE_CHARS)
      },
      {
        role: "model",
        text: answer.slice(0, MAX_HISTORY_MESSAGE_CHARS)
      }
    ].slice(-MAX_HISTORY_MESSAGES);

    return res.status(200).json(
      aliceResponse(answer, false, history)
    );
  } catch (error) {
    const safeError =
      error?.message === "AbortError" || error?.name === "AbortError"
        ? { message: "TIME_BUDGET_EXHAUSTED" }
        : error;

    console.warn(
      "Alice webhook returned a fallback response:",
      safeError?.message || "unknown error"
    );

    return res.status(200).json(
      aliceResponse(errorForUser(safeError), false, oldHistory)
    );
  }
}

export {
  aliceResponse,
  fitAliceText,
  isSearchIntent,
  safeHistory
};
