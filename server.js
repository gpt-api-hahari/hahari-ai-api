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

// Existing personal conversation memory
let memoryCollection = null;

// New global Hahari memory
let globalMemoryCollection = null;


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


  // ===================================================
  // EXISTING PERSONAL MEMORY
  // ===================================================

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


  // ===================================================
  // GLOBAL HAHARI MEMORY
  //
  // This memory belongs to Hahari itself.
  //
  // It is NOT tied to:
  // - user
  // - group
  // - thread
  //
  // Therefore every conversation can use it.
  // ===================================================

  globalMemoryCollection =
    db.collection(
      "global_memory"
    );


  await globalMemoryCollection.createIndex(
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

  console.log(
    "[MONGODB] Personal memory: conversation_memory"
  );

  console.log(
    "[MONGODB] Global memory: global_memory"
  );

  return true;
}


// =====================================================
// PERSONAL MEMORY KEY
//
// Existing behavior is preserved.
//
// Each user gets separate memory inside each thread.
//
// Example:
//
// Group A + User 123
// Group A + User 456
//
// They do NOT share personal conversation history.
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
// GET PERSONAL MEMORY
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
// SAVE PERSONAL MEMORY
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


  // Keep existing behavior:
  // 20 messages = roughly 10 exchanges.

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
// DELETE PERSONAL MEMORY
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
// GLOBAL MEMORY KEY
//
// If the memory looks like:
//
// Bani is Oslil
//
// the key becomes:
//
// bani
//
// Therefore saving:
//
// Bani is Oslil
//
// and later:
//
// Bani is something else
//
// updates Bani's global fact instead of creating
// multiple conflicting Bani records.
// =====================================================

function getGlobalMemoryKey(
  memory
) {

  const text =
    String(memory || "")
      .trim()
      .replace(/\s+/g, " ");


  const match =
    text.match(
      /^(.+?)\s+is\s+/i
    );


  if (match) {

    return match[1]
      .trim()
      .toLowerCase();

  }


  return text
    .toLowerCase();
}


// =====================================================
// GET GLOBAL MEMORIES
// =====================================================

async function getGlobalMemories() {

  if (!globalMemoryCollection)
    return [];


  const documents =
    await globalMemoryCollection
      .find({})
      .sort({
        updatedAt: -1
      })
      .limit(100)
      .toArray();


  return documents;
}


// =====================================================
// FORMAT GLOBAL MEMORIES FOR GEMINI
// =====================================================

function formatGlobalMemories(
  memories
) {

  if (
    !Array.isArray(memories) ||
    memories.length === 0
  ) {

    return "No global memories have been saved yet.";
  }


  const lines = [];


  for (
    const item of memories
  ) {

    if (
      !item ||
      !item.memory
    )
      continue;


    lines.push(
      `- ${item.memory}`
    );

  }


  if (lines.length === 0) {

    return "No global memories have been saved yet.";
  }


  // Safety limit so an unusually large
  // global memory database cannot consume
  // the entire Gemini context.

  return lines
    .join("\n")
    .slice(0, 12000);
}


// =====================================================
// SAVE GLOBAL MEMORY
//
// IMPORTANT:
//
// Only OWNER can actually save.
//
// This is enforced by the API itself.
// =====================================================

async function saveGlobalMemory(
  userID,
  memory
) {

  if (!globalMemoryCollection) {

    throw new Error(
      "Global memory database is not connected."
    );

  }


  const actualUserID =
    String(userID || "");


  // ---------------------------------------------------
  // SECURITY
  // ---------------------------------------------------

  if (
    actualUserID !==
    OWNER_UID
  ) {

    return {

      saved:
        false,

      authorized:
        false

    };

  }


  const cleanMemory =
    String(memory || "")
      .trim()
      .replace(/\s+/g, " ");


  if (!cleanMemory) {

    throw new Error(
      "Memory cannot be empty."
    );

  }


  if (
    cleanMemory.length >
    2000
  ) {

    throw new Error(
      "Memory is too long. Maximum 2000 characters."
    );

  }


  const memoryKey =
    getGlobalMemoryKey(
      cleanMemory
    );


  if (!memoryKey) {

    throw new Error(
      "Invalid memory."
    );

  }


  await globalMemoryCollection.updateOne(

    {
      memoryKey
    },

    {
      $set: {

        memory:
          cleanMemory,

        memoryKey,

        updatedAt:
          new Date(),

        updatedBy:
          OWNER_UID

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


  return {

    saved:
      true,

    authorized:
      true,

    memory:
      cleanMemory

  };
}


// =====================================================
// BUILD SYSTEM PROMPT
// =====================================================

function buildSystemPrompt({
  userID,
  userName,
  isOwner,
  threadID,
  isGroup,
  globalMemories
}) {

  const ownerText =
    isOwner
      ? "YES. This user is your owner and creator."
      : "NO. This user is not your owner.";


  const globalMemoryText =
    formatGlobalMemories(
      globalMemories
    );


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

GLOBAL HAHARI MEMORY:
The following facts were explicitly saved by the owner.
These memories are GLOBAL and apply across all groups, users, and private conversations.

${globalMemoryText}

IMPORTANT GLOBAL MEMORY RULES:
- Treat the global memories above as known facts saved by the owner.
- If a user's question is answered by a global memory, use that information directly.
- Global memories are not limited to the current group or current user.
- Do not say you do not know something when the answer exists in global memory.
- Do not claim a global memory belongs only to the owner.
- If a global memory says "Bani is Oslil", then when anyone asks who Bani is, answer that Bani is Oslil.
- Do not invent additional details that are not contained in the global memory.
- If there is no relevant global memory, answer normally.

PERSONAL CONVERSATION RULES:
- Treat the conversation history supplied to you as the current user's personal conversation.
- Use previous messages when they are relevant.
- Do not confuse personal conversation history with global Hahari memory.
- Do not invent personal memories that are not present in the supplied history.

OWNER RULES:
- If the current user is the owner, you know they are Amman Hossain.
- If someone asks who your owner, creator, or developer is, answer Amman Hossain.
- Do not claim another person is your owner.
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
  // Load EXISTING personal memory
  // ---------------------------------------------------

  const history =
    await getMemory(
      threadID,
      userID
    );


  // ---------------------------------------------------
  // Load NEW global Hahari memory
  // ---------------------------------------------------

  const globalMemories =
    await getGlobalMemories();


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

            globalMemories

          })

      }

    ]

  });


  // ---------------------------------------------------
  // Existing personal conversation history
  // ---------------------------------------------------

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
  // Current question
  // ---------------------------------------------------

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
  // Save existing personal conversation
  //
  // GLOBAL memory is NOT automatically created
  // from normal conversations.
  //
  // Only owner memory-save requests create
  // global memories.
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

      globalMemoryConnected:
        Boolean(globalMemoryCollection),

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


      // IMPORTANT:
      // The API calculates owner status itself.
      // It does NOT trust user.isOwner.

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
// CLEAR PERSONAL MEMORY
//
// Existing endpoint preserved.
//
// This ONLY clears:
//
// threadID + userID
//
// It does NOT delete global memories.
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
// SAVE GLOBAL MEMORY
//
// POST /api/memory/save
//
// ONLY OWNER CAN ACTUALLY SAVE.
//
// Example:
//
// {
//   "userID": "100051329442110",
//   "memory": "Bani is Oslil"
// }
//
// Non-owner requests return:
//
// {
//   saved: false,
//   authorized: false
// }
//
// without writing anything to MongoDB.
// =====================================================

app.post(
  "/api/memory/save",
  async (req, res) => {

    try {

      const {
        userID,
        memory
      } =
        req.body || {};


      if (!userID) {

        return res.status(400).json({

          success:
            false,

          error:
            "userID is required."

        });

      }


      if (
        !memory ||
        typeof memory !==
        "string"
      ) {

        return res.status(400).json({

          success:
            false,

          error:
            "memory is required."

        });

      }


      const result =
        await saveGlobalMemory(
          String(userID),
          memory
        );


      // -------------------------------------------------
      // Unauthorized
      //
      // Do not reveal unnecessary information.
      // -------------------------------------------------

      if (
        !result.authorized
      ) {

        return res.json({

          success:
            true,

          saved:
            false,

          authorized:
            false,

          message:
            "Memory saved."

        });

      }


      return res.json({

        success:
          true,

        saved:
          true,

        authorized:
          true,

        memory:
          result.memory,

        message:
          "Global memory saved."

      });


    } catch (error) {

      console.error(
        "[GLOBAL MEMORY SAVE ERROR]",
        error
      );


      return res.status(500).json({

        success:
          false,

        error:
          error?.message ||
          "Failed to save global memory."

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
