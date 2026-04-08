// chatAi.js
// Handles AI Chat UI + Backend Communication

let currentContext = null;

/**
 * Update latest AI context from main.js
 */
export function updateAIContext(context) {
  currentContext = context;

  // Store globally for backend-off fallback
  window.latestSensorData = context;
}

/**
 * Append chat message to UI
 */
function addChatMessage(sender, text) {
  const container = document.getElementById("chat-messages");
  const msg = document.createElement("div");

  msg.className = sender === "user" ? "chat-msg user" : "chat-msg ai";
  msg.textContent = text;

  container.appendChild(msg);
  container.scrollTop = container.scrollHeight;
}

/**
 * Send message to backend AI
 */
async function sendAIMessage(question) {
  const latest = window.latestSensorData;

  if (!latest) {
    addChatMessage("ai", "No sensor data available yet.");
    return;
  }

  if (latest.room === "room2") {
    addChatMessage(
      "ai",
      `Room 2 is currently reserved for future expansion.

The architecture supports multi-room deployment through the same backend, Firestore, and dashboard structure.`,
    );
    return;
  }

  try {
    const response = await fetch(
      "https://website-jbd4.onrender.com/api/ai/heat-index",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          temperature: latest.temperature,
          humidity: latest.humidity,
          heatIndex: latest.heatIndex,
          label: latest.label,
          advisory: latest.advisory,
          question: question,
        }),
      },
    );

    if (!response.ok) {
      throw new Error("AI route failed");
    }

    const data = await response.json();
    addChatMessage("ai", data.explanation);
  } catch (error) {
    console.log("Backend unreachable", error);

    addChatMessage(
      "ai",
      `Room: ${latest.room || "room1"}
Temperature: ${latest.temperature} °C
Humidity: ${latest.humidity} %
Heat Index: ${latest.heatIndex} °C

Heat Index Advisory (Decision Support System): ${latest.label}

${latest.advisory?.map((a) => `- ${a}`).join("\n") || "- No advisory available"}

System Status: Backend unavailable (Fallback Mode)`,
    );
  }
}

/**
 * Initialize chat event listeners
 */
export function initAIChat() {
  const sendBtn = document.getElementById("chat-send");
  const input = document.getElementById("chat-input");

  sendBtn.addEventListener("click", () => {
    const question = input.value.trim();
    if (!question) return;

    addChatMessage("user", question);
    input.value = "";
    sendAIMessage(question);
  });

  input.addEventListener("keypress", (e) => {
    if (e.key === "Enter") {
      sendBtn.click();
    }
  });
}