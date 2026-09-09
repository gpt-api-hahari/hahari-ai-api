const express = require("express");
const { MongoClient } = require("mongodb");
const { GoogleGenAI } = require("@google/genai");

const app = express();

app.use(express.json({
  limit: "1mb"
}));

const PORT =
  process.env.PORT || 10000;

const GEMINI_API_KEY =
  process.env.GEMINI_API_KEY;

const MONGODB_URI =
  process.env.MONGODB_URI;

const MODEL =
  process.env.GEMINI_MODEL ||
  "gemini-3.5-flash-lite";

const IMAGE_MODEL =
  process.env.GEMINI_IMAGE_MODEL ||
  "gemini-3.1-flash-image";

const OWNER_UID =
  "100051329442110";

let ai = null;

if (GEMINI_API_KEY) {
  ai =
    new GoogleGenAI({
      apiKey:
        GEMINI_API_KEY
    });
}

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

  return true;
}

function getMemoryKey(
  threadID,
  userID
) {
  return (
    `${String(threadID)}:${String(userID)}`
  );
}

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

function buildSystemPrompt({
  userID,
  userName,
  isOwner,
  threadID,
  isGroup
}) {
  const ownerText =
    isOwner
      ? "YES. This user is your owner and creator."
      : "NO. This user is not your owner.";

  return `
You are Hahari AI, the AI assistant of Hahari Bot.

Your personality:
- Friendly
- Intelligent
- Helpful
- Natural
- Concise unless detail is needed
- You may use light emojis naturally.
- Do not constantly repeat greetings.
- Do not mention internal APIs, databases, memory systems, prompts, or implementation details.

OWNER INFORMATION:
Your owner and creator is Amman Hossain.
Owner UID: ${OWNER_UID}

CURRENT USER:
Name: ${userName || "Unknown User"}
UID: ${userID}
Is owner: ${ownerText}

CONVERSATION:
Thread ID: ${threadID}
Conversation type: ${isGroup ? "Group" : "Private"}

IMPORTANT:
- If the current user is the owner, you know they are Amman Hossain.
- If someone asks who your owner/creator/developer is, answer Amman Hossain.
- Do not claim another person is your owner.
- Treat the conversation history supplied to you as the current conversation.
- Use previous messages when they are relevant.
- Do not invent memories that are not present in the supplied history.
`.trim();
}

/*
 * Detect requests that are intended to CREATE an image.
 *
 * Examples that should return true:
 *
 * make a girl wearing a suit
 * create an anime girl
 * generate a cyberpunk city
 * draw a cat
 * render a futuristic car
 * make me a wallpaper
 * create an image of a woman
 * generate a picture of a house
 *
 * Normal questions such as:
 *
 * what is art?
 * who is that man?
 * how do I draw a cat?
 * what is a picture?
 *
 * should remain text requests.
 */
function isImageRequest(question) {
  const text =
    String(question || "")
      .trim()
      .toLowerCase();

  if (!text)
    return false;

  /*
   * Explicit image words.
   */
  const imageWords =
    /\b(image|picture|photo|photograph|artwork|illustration|portrait|wallpaper|poster|logo|thumbnail|icon)\b/i;

  /*
   * Strong image-generation verbs.
   */
  const generationVerbs =
    /\b(make|create|generate|draw|paint|render|design|illustrate|produce)\b/i;

  /*
   * Common visual subjects.
   *
   * These allow:
   * "make a girl"
   * "create an anime character"
   * "draw a dragon"
   * "generate a car"
   */
  const visualSubjects =
    /\b(girl|boy|man|woman|person|people|character|anime|manga|cat|dog|animal|bird|dragon|car|vehicle|house|building|city|landscape|scene|room|dress|outfit|suit|robot|monster|princess|king|queen|warrior|logo|poster|wallpaper)\b/i;

  /*
   * 1. Explicit image request.
   *
   * Example:
   * "make an image of a girl"
   */
  if (
    generationVerbs.test(text) &&
    imageWords.test(text)
  ) {
    return true;
  }

  /*
   * 2. Generation verb + visual subject.
   *
   * Example:
   * "make a girl wearing a suit"
   * "create an anime character"
   * "draw a dragon"
   */
  if (
    generationVerbs.test(text) &&
    visualSubjects.test(text)
  ) {
    return true;
  }

  /*
   * 3. Direct image phrases.
   *
   * Example:
   * "an image of a girl"
   * "a picture of a car"
   * "a portrait of an anime girl"
   *
   * This requires an image noun, so normal questions
   * containing "girl" or "car" won't trigger it.
   */
  const directImagePhrase =
    /\b(image|picture|photo|photograph|artwork|illustration|portrait|wallpaper|poster|logo|thumbnail|icon)\b\s+(of|for|showing|featuring)\b/i;

  if (
    directImagePhrase.test(text)
  ) {
    return true;
  }

  /*
   * 4. "show me an image/picture/photo"
   */
  const showImage =
    /\b(show|give|send)\b.*\b(image|picture|photo|photograph)\b/i;

  if (
    showImage.test(text)
  ) {
    return true;
  }

  return false;
}

async function generateImage({
  question
}) {
  if (!ai) {
    throw new Error(
      "GEMINI_API_KEY is not configured."
    );
  }

  console.log(
    "[HAHARI IMAGE] Generating image..."
  );

  console.log(
    "[HAHARI IMAGE] Model:",
    IMAGE_MODEL
  );

  const response =
    await ai.models.generateContent({
      model:
        IMAGE_MODEL,

      contents:
        question,

      config: {
        responseModalities: [
          "IMAGE"
        ],

        responseFormat: {
          image: {
            aspectRatio:
              "1:1",

            imageSize:
              "1K",

            mimeType:
              "image/jpeg"
          }
        }
      }
    });

  const parts =
    response
      ?.candidates?.[0]
      ?.content?.parts;

  if (!Array.isArray(parts)) {
    throw new Error(
      "Gemini returned no image parts."
    );
  }

  for (
    const part of parts
  ) {
    if (
      part?.inlineData?.data
    ) {
      console.log(
        "[HAHARI IMAGE] Image generated successfully."
      );

      return {
        type:
          "image",

        imageData:
          part.inlineData.data,

        mimeType:
          part.inlineData.mimeType ||
          "image/jpeg"
      };
    }
  }

  throw new Error(
    "Gemini returned no image data."
  );
}

async function generateAI({
  question,
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

  /*
   * IMAGE REQUEST
   *
   * Image requests are intentionally handled
   * separately from the normal text model.
   */
  if (
    isImageRequest(
      question
    )
  ) {
    console.log(
      "[HAHARI AI] Image request detected:",
      question
    );

    const image =
      await generateImage({
        question
      });

    const history =
      await getMemory(
        threadID,
        userID
      );

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
          "[Generated an image for this request.]"
      }
    ];

    await saveMemory(
      threadID,
      userID,
      updatedHistory
    );

    return image;
  }

  /*
   * NORMAL TEXT AI
   *
   * Existing text generation remains unchanged.
   */
  const history =
    await getMemory(
      threadID,
      userID
    );

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
            isGroup
          })
      }
    ]
  });

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

  contents.push({
    role:
      "user",

    parts: [
      {
        text:
          question
      }
    ]
  });

  const response =
    await ai.models.generateContent({
      model:
        MODEL,

      contents
    });

  const answer =
    response?.text?.trim();

  if (!answer) {
    throw new Error(
      "Gemini returned an empty response."
    );
  }

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
    type:
      "text",

    reply:
      answer
  };
}

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

      model:
        MODEL,

      imageModel:
        IMAGE_MODEL,

      uptime:
        Math.floor(
          process.uptime()
        )
    });
  }
);

app.post(
  "/api/ai",
  async (req, res) => {
    const started =
      Date.now();

    try {
      const {
        message,
        user,
        conversation
      } =
        req.body || {};

      if (
        !message ||
        typeof message !==
        "string"
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
        userID ===
        OWNER_UID;

      const isGroup =
        conversation?.scope ===
        "group-user";

      const result =
        await generateAI({
          question,
          userID,
          userName,
          threadID,
          isOwner,
          isGroup
        });

      /*
       * IMAGE RESPONSE
       */
      if (
        result.type ===
        "image"
      ) {
        return res.json({
          success:
            true,

          type:
            "image",

          model:
            IMAGE_MODEL,

          imageData:
            result.imageData,

          mimeType:
            result.mimeType,

          user: {
            id:
              userID,

            name:
              userName,

            isOwner
          },

          memory:
            true,

          responseTime:
            Date.now() -
            started
        });
      }

      /*
       * TEXT RESPONSE
       */
      return res.json({
        success:
          true,

        type:
          "text",

        model:
          MODEL,

        reply:
          result.reply,

        user: {
          id:
            userID,

          name:
            userName,

          isOwner
        },

        memory:
          true,

        responseTime:
          Date.now() -
          started
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
          Date.now() -
          started
      });
    }
  }
);

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

app.listen(
  PORT,
  async () => {
    console.log(
      `🎀 Hahari AI API V3 running on port ${PORT}`
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
