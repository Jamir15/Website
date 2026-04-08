// Backend/services/openaiService.js

const OpenAI = require("openai");
const buildHeatIndexPrompt = require("../ai/heatIndexAssistantPrompt");

const client = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY
});

async function getHeatIndexAIResponse(context) {

    if (!context) {
        return `
Heat Index Advisory (Decision Support System): No Data Available

System Status: Sensors are down
`;
    }

    try {
        const prompt = buildHeatIndexPrompt(context);

        const response = await client.chat.completions.create({
            model: "gpt-4o-mini",
            messages: [
                {
                    role: "system",
                    content: "You are an environmental decision-support assistant for smart buildings."
                },
                {
                    role: "user",
                    content: prompt
                }
            ],
            temperature: 0.4
        });

        return response.choices[0].message.content;

    } catch (error) {

        console.error("❌ OpenAI error:", error.message);

        return `
Temperature: ${context.temperature} °C
Humidity: ${context.humidity} %
Heat Index: ${context.heatIndex} °C

Heat Index Advisory (Decision Support System): ${context.label}

${
  Array.isArray(context.advisory)
    ? context.advisory.map(a => `- ${a}`).join("\n")
    : context.advisory
      ? `- ${context.advisory}`
      : "- No advisory available"
}

System Status: Sensors are down
`;
    }
}

module.exports = {
    getHeatIndexAIResponse
};