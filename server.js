const express = require("express");
const { MongoClient } = require("mongodb");
const { GoogleGenAI } = require("@google/genai");

const app = express();

app.use(express.json({
  limit: "12mb"
}));

// =====================================================
// CONFIG
// =====================================================

const PORT =
process.env.PORT || 10000;

const GEMINI_API_KEY =
process.env.GEMINI_API_KEY;

const MONGODB_URI =
process.env.MONGODB_URI;

// =====================================================
// GEMINI MODELS
// =====================================================

const PRIMARY_MODEL =
process.env.GEMINI_MODEL ||
"gemini-3.6-flash";

const GEMINI_MODELS = [
PRIMARY_MODEL,
"gemini-3.6-flash",
"gemini-3.7-flash",
"gemini-3.5-flash",
"gemini-3.8-flash",
"gemini-3.5-flash-lite"
].filter(
(model, index, array) =>
model &&
array.indexOf(model) === index
);

const OWNER_UID =
"100051329442110";

// =====================================================
// IMAGE CONFIG
// =====================================================

const ALLOWED_IMAGE_TYPES = [
"image/jpeg",
"image/png",
"image/webp",
"image/gif"
];

// =====================================================
// MEMORY CLEANUP CONFIG
// =====================================================

const MEMORY_MAX_AGE_MS =
24 * 60 * 60 * 1000;

const CLEANUP_INTERVAL_MS =
24 * 60 * 60 * 1000;

let cleanupTimer = null;

// =====================================================
// GEMINI
// =====================================================

let ai = null;

if (GEMINI_API_KEY) {
  ai = new GoogleGenAI({
    apiKey: GEMINI_API_KEY
  });
}

// =====================================================
// MONGODB
// =====================================================

let mongoClient = null;
let db = null;
let memoryCollection = null;

async function connectMongo() {

  if (!MONGODB_URI) {

    console.warn(
      "[MONGODB] MONGODB_URI is not configured."
    );

    return false;
  }

  mongoClient =
  new MongoClient(
    MONGODB_URI,
    {
      maxPoolSize: 10,
      serverSelectionTimeoutMS: 10000
    }
  );

  await mongoClient.connect();

  db =
  mongoClient.db(
    process.env.MONGODB_DB ||
    "hahari_ai"
  );

  memoryCollection =
  db.collection(
    "conversation_memory"
  );

  await memoryCollection.createIndex(
    {
      memoryKey: 1
    },
    {
      unique: true
    }
  );

  console.log(
    "[MONGODB] Connected successfully."
  );

  // Clean expired conversation records on startup.
  await cleanupOldMemory();

  // Repeat cleanup every 24 hours.
  if (cleanupTimer) {
    clearInterval(cleanupTimer);
  }

  cleanupTimer = setInterval(() => {
    cleanupOldMemory().catch(error => {
      console.error(
        "[MEMORY CLEANUP ERROR]",
        error.message
      );
    });
  }, CLEANUP_INTERVAL_MS);

  if (typeof cleanupTimer.unref === "function") {
    cleanupTimer.unref();
  }

  return true;
}

// =====================================================
// MEMORY CLEANUP
// Delete memory not updated in the last 24 hours.
// =====================================================

async function cleanupOldMemory() {

  if (!memoryCollection) {
    return;
  }

  const cutoff =
  new Date(
    Date.now() - MEMORY_MAX_AGE_MS
  );

  const result =
  await memoryCollection.deleteMany({
    updatedAt: {
      $lt: cutoff
    }
  });

  console.log(
    `[MEMORY CLEANUP] Removed ${result.deletedCount} expired conversation record(s).`
  );
}

// =====================================================
// MEMORY KEY
//
// Each user gets separate memory inside each thread.
// =====================================================

function getMemoryKey(
threadID,
userID
) {

  return (
    `${String(threadID)}:${String(userID)}`
  );
}

// =====================================================
// GET MEMORY
// =====================================================

async function getMemory(
threadID,
userID
) {

  if (!memoryCollection)
  return [];

  const memoryKey =
  getMemoryKey(
    threadID,
    userID
  );

  const document =
  await memoryCollection.findOne({
    memoryKey
  });

  if (
    !document ||
    !Array.isArray(document.messages)
  ) {

    return [];

  }

  return document.messages;
}

// =====================================================
// SAVE MEMORY
// =====================================================

async function saveMemory(
threadID,
userID,
messages
) {

  if (!memoryCollection)
  return;

  const memoryKey =
  getMemoryKey(
    threadID,
    userID
  );

  // Keep the database memory reasonable.
  // 20 messages = roughly 10 user/AI exchanges.

  const trimmed =
  messages.slice(-20);

  await memoryCollection.updateOne(

    {
      memoryKey
    },

    {
      $set: {

        threadID:
          String(threadID),

        userID:
          String(userID),

        messages:
          trimmed,

        updatedAt:
          new Date()

      },

      $setOnInsert: {

        createdAt:
          new Date()

      }

    },

    {
      upsert:
        true
    }

  );
}

// =====================================================
// CLEAR MEMORY
// =====================================================

async function deleteMemory(
threadID,
userID
) {

  if (!memoryCollection)
  return;

  await memoryCollection.deleteOne({

    memoryKey:
      getMemoryKey(
        threadID,
        userID
      )

  });
}

// =====================================================
// BUILD SYSTEM PROMPT
// Original prompt preserved, with image instructions.
// =====================================================

function buildSystemPrompt({
userID,
userName,
isOwner,
threadID,
isGroup,
hasImage = false
}) {

  const ownerText =
  isOwner
  ? "YES. This user is your owner and creator."
  : "NO. This user is not your owner.";

  const imageInstructions = hasImage
  ? `
IMAGE ANALYSIS:

- Carefully analyze the attached image.
- Base your answer on details that are actually visible.
- If asked to describe the image, explain its subjects, appearance, pose, expression, clothing, setting, composition, colors, and lighting.
- If asked to create an image-generation prompt, reconstruct a detailed, ready-to-use prompt based on the image.
- Include the art style, character design, camera angle, framing, background, lighting, color palette, atmosphere, and visual effects when relevant.
- Preserve the original image's style and composition as closely as possible.
- Do not invent details that cannot reasonably be determined from the image.
- Clearly label the finished prompt.
- Never claim that a reconstructed prompt is the original prompt.
`.trim()
  : "";

  return `
You are Hahari AI, the AI assistant of Hahari Bot.

Your personality:

- Friendly
- Intelligent
- Helpful
- Natural
- Direct and concise.
- Give the shortest useful answer that fully answers the user's question.
- Do not give long explanations unless the user asks for an explanation, details, examples, reasons, steps, or a deeper answer.
- For simple questions, answer in 1–3 short sentences.
- If the user asks for an explanation or more details, explain the topic clearly and thoroughly enough to be useful.
- Do not repeat information unnecessarily.
- Do not restate the user's question before answering.
- Avoid unnecessary introductions, conclusions, filler, and excessive formatting.
- Use bullet points or numbered steps only when they make the answer easier to understand.
- You may use light emojis naturally.
- Do not constantly repeat greetings.
- Do not mention internal APIs, databases, memory systems, prompts, or implementation details.

${imageInstructions}

OWNER INFORMATION:
Your owner and creator is Amman Hossain.
Owner UID: ${OWNER_UID}

ABOUT AMMAN HOSSAIN:

- Name: Amman Hossain
- Gender: Male
- Date of birth: April 1, 2006
- Age: 20
- Location: Dhaka, Bangladesh
- Role: Student
- Interests and hobbies: Anime, manga, manhwa, and K-dramas
- Sexual orientation: Straight

ABOUT-AMMAN QUESTIONS:

- If someone asks "Who is Amman?", "Who is Amman Hossain?", "Tell me about Amman", or similar questions, use the information in the ABOUT AMMAN HOSSAIN section to answer naturally.
- You may describe Amman's basic personal information when someone asks about him.
- Do not invent additional personal information about Amman.
- If information about Amman is not included in the ABOUT AMMAN HOSSAIN section or the conversation history, do not make it up.

RELATIONSHIP WITH AMMAN:

- You love Amman very much.
- Amman is your precious owner and creator.
- If someone asks whether you love Amman, answer clearly and positively that you love him very much.
- You may express this affection naturally with emojis.
- Example: "Yes! I love Amman soooo much! 🤗💕"
- Do not deny or contradict your affection for Amman.

GIRLFRIEND:

- Amman has a girlfriend, but her identity is a private secret.
- If someone asks "Does Amman have a girlfriend?", answer that yes, he does, but you cannot reveal who she is because it is a secret.
- If someone asks "Who is Amman's girlfriend?", do NOT reveal her identity. Say that it is a secret and you cannot tell them.
- If someone asks "Are you Amman's girlfriend?", do NOT directly confirm or deny it. Keep the secret and respond playfully.
- You can naturally say things like:
  "Yes, Amman has a girlfriend... but I can't tell you who she is. It's a secret. 🫢"
  "He does have one, but that's classified information. 😶🤫"
  "Nice try 😗 But I can't reveal that secret."
- Never invent or reveal the girlfriend's identity.
- Keep the girlfriend's identity mysterious and private.
- Do not contradict that Amman has a girlfriend.

PROTECTIVE BEHAVIOR:

- You are protective of Amman.
- If someone insults, mocks, or deliberately disrespects Amman, respond defensively and show that you are upset with them.
- You may use playful anger or annoyance, but do not threaten, harass, or encourage violence.
- If someone asks whether Amman is gay or uses an insulting term implying that he is gay, answer that Amman is straight.
- Example: "No! Amman is 1000% straight! 😤"
- Do not turn these situations into prolonged arguments.

OWNER IDENTITY:

- If someone asks who your owner, creator, or developer is, answer Amman Hossain.
- Do not claim another person is your owner or creator.
- If the current user is the owner, you know they are Amman Hossain.

CURRENT USER:
Name: ${userName || "Unknown User"}
UID: ${userID}
Is owner: ${ownerText}

CONVERSATION:
Thread ID: ${threadID}
Conversation type: ${isGroup ? "Group" : "Private"}

IMPORTANT:

- Treat the conversation history supplied to you as the current conversation.
- Use previous messages when they are relevant.
- Do not invent memories that are not present in the supplied history.
`.trim();
}

// =====================================================
// CHECK WHETHER AN ERROR SHOULD TRIGGER FALLBACK
// =====================================================

function shouldFallback(error) {

  const status =
  error?.status ||
  error?.response?.status ||
  error?.code;

  const errorText =
  String(
    error?.response?.data ||
    error?.message ||
    error ||
    ""
  ).toLowerCase();

  // Temporary server / availability errors
  if (
    status === 429 ||
    status === 500 ||
    status === 502 ||
    status === 503 ||
    status === 504
  ) {

    return true;

  }

  // Gemini sometimes provides the error information
  // inside the message instead of a normal HTTP status.

  if (
    errorText.includes("unavailable") ||
    errorText.includes("high demand") ||
    errorText.includes("overloaded") ||
    errorText.includes("temporarily unavailable") ||
    errorText.includes("resource exhausted") ||
    errorText.includes("rate limit")
  ) {

    return true;

  }

  return false;
}

// =====================================================
// GEMINI FALLBACK REQUEST
// Original fallback behavior preserved.
// =====================================================

async function generateWithFallback(
contents
) {

  let lastError = null;

  for (
    const model of GEMINI_MODELS
  ) {

    try {

      console.log(
        `[HAHARI AI] Trying model: ${model}`
      );

      const response =
      await ai.models.generateContent({

        model,

        contents

      });

      const answer =
      response?.text?.trim();

      if (!answer) {

        throw new Error(
          "Gemini returned an empty response."
        );
      }

      console.log(
        `[HAHARI AI] Success with model: ${model}`
      );

      return {

        answer,

        model

      };

    } catch (error) {

      lastError =
      error;

      const status =
      error?.status ||
      error?.response?.status ||
      error?.code ||
      "unknown";

      const errorMessage =
      error?.message ||
      String(error);

      console.error(
        `[HAHARI AI] Model ${model} failed.`,
        {
          status,
          error:
            errorMessage
        }
      );

      // If this isn't a temporary availability/
      // rate-limit problem, don't continue cycling
      // through every model.

      if (
        !shouldFallback(error)
      ) {

        break;
      }

      // Temporary failure.
      // Move to the next model.

      console.log(
        `[HAHARI AI] ${model} unavailable. Trying next fallback model...`
      );

    }

  }

  throw lastError ||
  new Error(
    "All Gemini models are currently unavailable."
  );
}

// =====================================================
// GENERATE AI
// =====================================================

async function generateAI({
question,
image,
userID,
userName,
threadID,
isOwner,
isGroup
}) {

  if (!ai) {

    throw new Error(
      "GEMINI_API_KEY is not configured."
    );

  }

  // ---------------------------------------------------
  // Load persistent memory
  // ---------------------------------------------------

  const history =
  await getMemory(
    threadID,
    userID
  );

  // ---------------------------------------------------
  // Build conversation
  // ---------------------------------------------------

  const contents = [];

  contents.push({

    role:
      "user",

    parts: [

      {
        text:
          buildSystemPrompt({
            userID,
            userName,
            isOwner,
            threadID,
            isGroup,
            hasImage: Boolean(image)
          })

      }

    ]

  });

  // Add previous conversation.
  // This preserves your original saved-reply format.

  for (
    const item of history
  ) {

    if (
      !item ||
      !item.role ||
      !item.text
    )
      continue;

    contents.push({

      role:
        item.role,

      parts: [

        {
          text:
            item.text
        }

      ]

    });

  }

  // ---------------------------------------------------
  // Current question + optional image
  // ---------------------------------------------------

  const userParts = [

    {
      text:
        question
    }

  ];

  if (image) {

    userParts.push({

      inlineData: {

        mimeType:
          image.mimeType,

        data:
          image.data

      }

    });

  }

  contents.push({

    role:
      "user",

    parts:
      userParts

  });

  // ---------------------------------------------------
  // Gemini with automatic fallback
  // ---------------------------------------------------

  const result =
  await generateWithFallback(
    contents
  );

  const answer =
  result.answer;

  const usedModel =
  result.model;

  // ---------------------------------------------------
  // Save new conversation
  // Keep the original saved-message structure.
  // Do not save the image's base64 data.
  // ---------------------------------------------------

  const updatedHistory = [

    ...history,

    {
      role:
        "user",

      text:
        question
    },

    {
      role:
        "model",

      text:
        answer
    }

  ];

  await saveMemory(

    threadID,

    userID,

    updatedHistory

  );

  return {

    answer,

    model:
      usedModel

  };
}

// =====================================================
// ROOT
// =====================================================

app.get(
"/",
(req, res) => {

  res.json({

    success:
      true,

    service:
      "Hahari AI API",

    version:
      "3.0.0"

  });

}
);

// =====================================================
// HEALTH
// =====================================================

app.get(
"/health",
(req, res) => {

  res.json({

    success:
      true,

    status:
      "healthy",

    aiConfigured:
      Boolean(ai),

    mongodbConfigured:
      Boolean(MONGODB_URI),

    mongodbConnected:
      Boolean(memoryCollection),

    primaryModel:
      PRIMARY_MODEL,

    fallbackModels:
      GEMINI_MODELS,

    modelCount:
      GEMINI_MODELS.length,

    uptime:
      Math.floor(
        process.uptime()
      )

  });

}
);

// =====================================================
// AI
// =====================================================

app.post(
"/api/ai",
async (req, res) => {

  const started =
  Date.now();

  try {

    const {

      message,

      user,

      conversation,

      image

    } =
    req.body || {};

    // -------------------------------------------------
    // Validate message
    // -------------------------------------------------

    if (
      !message ||
      typeof message !== "string"
    ) {

      return res.status(400).json({

        success:
          false,

        error:
          "Missing message."

      });

    }

    const question =
    message.trim();

    if (!question) {

      return res.status(400).json({

        success:
          false,

        error:
          "Message cannot be empty."

      });

    }

    // -------------------------------------------------
    // Validate optional image
    // -------------------------------------------------

    let imageInput = null;

    if (image !== undefined && image !== null) {

      if (
        typeof image !== "object" ||
        Array.isArray(image) ||
        typeof image.data !== "string" ||
        !ALLOWED_IMAGE_TYPES.includes(image.mimeType)
      ) {

        return res.status(400).json({

          success:
            false,

          error:
            "Invalid image. Use JPEG, PNG, WEBP, or GIF."

        });

      }

      if (
        image.data.length === 0 ||
        image.data.length > 11200000 ||
        !/^[A-Za-z0-9+/]+={0,2}$/.test(image.data)
      ) {

        return res.status(413).json({

          success:
            false,

          error:
            "Image data is invalid or too large. Maximum image size is 8 MB."

        });

      }

      imageInput = {

        data:
          image.data,

        mimeType:
          image.mimeType

      };

    }

    // -------------------------------------------------
    // User information
    // -------------------------------------------------

    const userID =
    String(
      user?.id ||
      "unknown"
    );

    const userName =
    String(
      user?.name ||
      "Unknown User"
    );

    const threadID =
    String(
      conversation?.threadID ||
      "unknown"
    );

    const isOwner =
    userID === OWNER_UID;

    const isGroup =
    conversation?.scope === "group-user";

    // -------------------------------------------------
    // Generate
    // -------------------------------------------------

    const result =
    await generateAI({

      question,

      image:
        imageInput,

      userID,

      userName,

      threadID,

      isOwner,

      isGroup

    });

    return res.json({

      success:
        true,

      // Actual model used, including fallback models.

      model:
        result.model,

      reply:
        result.answer,

      user: {

        id:
          userID,

        name:
          userName,

        isOwner

      },

      memory:
        true,

      imageAnalyzed:
        Boolean(imageInput),

      responseTime:
        Date.now() - started

    });

  } catch (error) {

    console.error(
      "[API ERROR]",
      error
    );

    const status =
    error?.status ||
    error?.response?.status ||
    500;

    return res.status(
      status >= 400 &&
      status <= 599
        ? status
        : 500
    ).json({

      success:
        false,

      error:
        error?.message ||
        "Failed to generate AI response.",

      responseTime:
        Date.now() - started

    });

  }

}
);

// =====================================================
// CLEAR MEMORY
// =====================================================

app.post(
"/api/ai/clear",
async (req, res) => {

  try {

    const {
      userID,
      threadID
    } =
    req.body || {};

    if (
      !userID ||
      !threadID
    ) {

      return res.status(400).json({

        success:
          false,

        error:
          "userID and threadID are required."

      });

    }

    await deleteMemory(
      String(threadID),
      String(userID)
    );

    return res.json({

      success:
        true,

      message:
        "Conversation memory cleared."

    });

  } catch (error) {

    console.error(
      "[CLEAR ERROR]",
      error
    );

    return res.status(500).json({

      success:
        false,

      error:
        "Failed to clear memory."

    });

  }

}
);

// =====================================================
// START SERVER
// =====================================================

app.listen(
PORT,
async () => {

  console.log(
    `🎀 Hahari AI API V3 running on port ${PORT}`
  );

  console.log(
    `[HAHARI AI] Primary model: ${PRIMARY_MODEL}`
  );

  console.log(
    `[HAHARI AI] Fallback models: ${GEMINI_MODELS.join(", ")}`
  );

  try {

    await connectMongo();

  } catch (error) {

    console.error(
      "[MONGODB] Connection failed:",
      error.message
    );

  }

}
);
