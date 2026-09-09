const express = require("express");
const { MongoClient } = require("mongodb");
const { GoogleGenAI } = require("@google/genai");

const app = express();

app.use(express.json({
  limit: "1mb"
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

const MODEL =
  process.env.GEMINI_MODEL ||
  "gemini-3.5-flash-lite";

const OWNER_UID =
  "100051329442110";


// =====================================================
// GEMINI
// =====================================================

let ai = null;

if (GEMINI_API_KEY) {

  ai =
    new GoogleGenAI({
      apiKey:
        GEMINI_API_KEY
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

  return true;
}


// =====================================================
// MEMORY KEY
//
// Each user gets separate memory inside each thread.
//
// Example:
//
// Group A + User 123
// Group A + User 456
//
// They do NOT share the same conversation.
//
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
// =====================================================

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


// =====================================================
// GENERATE AI
// =====================================================

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
            isGroup
          })

      }

    ]

  });


  // Add previous conversation
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


  // Current question
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


  // ---------------------------------------------------
  // Gemini
  // ---------------------------------------------------

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


  // ---------------------------------------------------
  // Save new conversation
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


  return answer;
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

      model:
        MODEL,

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

        conversation

      } =
        req.body || {};


      // -------------------------------------------------
      // Validate
      // -------------------------------------------------

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


      // -------------------------------------------------
      // Generate
      // -------------------------------------------------

      const reply =
        await generateAI({

          question,

          userID,

          userName,

          threadID,

          isOwner,

          isGroup

        });


      return res.json({

        success:
          true,

        model:
          MODEL,

        reply,

        user:
          {
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
