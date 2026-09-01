const express = require("express");
const axios = require("axios");
require("dotenv").config();

const app = express();

app.use(express.json());

// ================================
// HAHARI AI CONFIG
// ================================

const AI_NAME = "Hahari-✿";
const OWNER_NAME = "Amman Hossain";

// ================================
// HOME
// ================================

app.get("/", (req, res) => {
  res.json({
    success: true,
    name: AI_NAME,
    message: "Hahari AI API is online! 🎀",
    version: "1.0.0"
  });
});

// ================================
// AI ENDPOINT
// ================================

app.post("/api/ai", async (req, res) => {
  try {
    const { message } = req.body;

    if (!message || typeof message !== "string") {
      return res.status(400).json({
        success: false,
        error: "Message is required."
      });
    }

    // Temporary response.
    // We will connect the actual AI model in the next step.

    const lower = message.toLowerCase();

    if (
      lower.includes("who is your owner") ||
      lower.includes("who owns you") ||
      lower.includes("who is your creator") ||
      lower.includes("who created you")
    ) {
      return res.json({
        success: true,
        reply: `My owner is ${OWNER_NAME}. 👑`
      });
    }

    if (
      lower.includes("what is your name") ||
      lower.includes("who are you")
    ) {
      return res.json({
        success: true,
        reply: `I'm ${AI_NAME}, your AI assistant. 🎀`
      });
    }

    return res.json({
      success: true,
      reply: "The AI model isn't connected yet. We'll add the AI brain next. 🧠"
    });

  } catch (error) {
    console.error("[AI ERROR]", error);

    return res.status(500).json({
      success: false,
      error: "Internal server error."
    });
  }
});

// ================================
// SERVER
// ================================

const PORT = process.env.PORT || 3000;

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Hahari AI API running on port ${PORT}`);
});
