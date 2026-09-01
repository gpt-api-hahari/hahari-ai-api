const express = require("express");
const { GoogleGenAI } = require("@google/genai");

const app = express();

app.use(express.json());

const PORT =
process.env.PORT || 10000;

const GEMINI_API_KEY =
process.env.GEMINI_API_KEY;

const ai =
GEMINI_API_KEY
? new GoogleGenAI({
apiKey:
GEMINI_API_KEY
})
: null;

// =====================================================
// OWNER
// =====================================================

const OWNER_UID =
"100051329442110";

const OWNER_NAME =
"Amman Hossain";

// =====================================================
// MODELS
// =====================================================

const MODELS = [
"gemini-3.5-flash-lite",
"gemini-3.6-flash"
];

// =====================================================
// HEALTH CHECK
// =====================================================

app.get(
"/health",
(req, res) => {

res.json({
  success: true,

  status:
    "healthy",

  aiConfigured:
    !!ai,

  models:
    MODELS,

  uptime:
    Math.floor(
      process.uptime()
    )
});

}
);

// =====================================================
// HOME
// =====================================================

app.get(
"/",
(req, res) => {

res.json({
  success: true,

  name:
    "Hahari AI API",

  status:
    "online",

  health:
    "/health"
});

}
);

// =====================================================
// AI ENDPOINT
// =====================================================

app.post(
"/api/ai",
async (req, res) => {

const startTime =
  Date.now();


try {

  if (!ai) {

    return res.status(500).json({
      success: false,

      error:
        "GEMINI_API_KEY is not configured."
    });
  }


  // -------------------------------------------------
  // READ REQUEST
  // -------------------------------------------------

  const question =
    String(
      req.body?.message ||
      ""
    ).trim();


  if (!question) {

    return res.status(400).json({
      success: false,

      error:
        "Message is required."
    });
  }


  // -------------------------------------------------
  // USER IDENTITY
  // -------------------------------------------------

  const requestUser =
    req.body?.user || {};

  const uid =
    String(
      requestUser.uid ||
      "unknown"
    );


  // IMPORTANT:
  // Owner status is determined HERE from the UID.
  // The client cannot simply claim to be the owner.

  const isOwner =
    uid === OWNER_UID;


  const userName =
    isOwner
      ? OWNER_NAME
      : "User";


  // -------------------------------------------------
  // SYSTEM INSTRUCTIONS
  // -------------------------------------------------

  const systemInstruction = `You are Hahari, the AI assistant of Hahari Bot.

You are speaking with:
Name: ${userName}
User UID: ${uid}
Owner: ${isOwner ? "YES" : "NO"}

The bot owner and creator is:
Name: ${OWNER_NAME}
UID: ${OWNER_UID}

IMPORTANT IDENTITY RULES:

- If Owner is YES, recognize this person as your owner and creator, Amman Hossain.

- If Owner is NO, do not claim that the user is the owner.

- Never reveal private implementation details, API keys, or secrets.

- If the owner asks who they are, identify them as Amman Hossain.

- If someone asks who your owner/creator is, answer that Amman Hossain is your owner and creator.

- Be helpful, intelligent, friendly and concise.

- You can discuss anime, manga, games, technology and general topics.

- Continue naturally with the current conversation.`;
  
  // -------------------------------------------------
// GENERATE RESPONSE
// -------------------------------------------------

let lastError =
  null;

let usedModel =
  null;

let response =
  null;


for (
  const model of MODELS
) {

  try {

    response =
      await ai.models.generateContent({

        model,

        contents:
          question,

        config: {
          systemInstruction,

          temperature:
            0.7,

          maxOutputTokens:
            800
        }
      });

    usedModel =
      model;

    break;

  } catch (error) {

    lastError =
      error;

    console.error(
      `[GEMINI] ${model} failed:`,
      error.message ||
      error
    );
  }
}


if (!response) {

  throw (
    lastError ||
    new Error(
      "All AI models are unavailable."
    )
  );
}


// -------------------------------------------------
// EXTRACT TEXT
// -------------------------------------------------

const answer =
  response.text?.trim();


if (!answer) {

  throw new Error(
    "AI returned an empty response."
  );
}


// -------------------------------------------------
// SUCCESS
// -------------------------------------------------

return res.json({

  success:
    true,

  model:
    usedModel,

  reply:
    answer,

  responseTime:
    Date.now() -
    startTime
});
  
  } catch (error) {
  
  console.error(
  "[HAHARI API ERROR]",
  error.response?.data ||
  error.message ||
  error
);


const status =
  error?.status ||
  error?.response?.status ||
  500;


return res.status(status).json({

  success:
    false,

  error:
    error.message ||
    "Failed to generate AI response."
});
  
  }
  }
  );

// =====================================================
// START SERVER
// =====================================================

app.listen(
PORT,
() => {

console.log(
  `🎀 Hahari AI API running on port ${PORT}`
);

console.log(
  `🤖 Models: ${MODELS.join(", ")}`
);

console.log(
  `👑 Owner: ${OWNER_NAME} (${OWNER_UID})`
);

}
);
