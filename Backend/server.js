/**
 * ============================================================
 * Smart Building Monitoring System - Backend Server
 * ============================================================
 * Responsibilities:
 *  - Read sensor data from Firestore
 *  - Compute average temperature & humidity
 *  - Compute heat index
 *  - Process thermal frame
 *  - Return unified room response
 * ============================================================
 */

const express = require("express");
const admin = require("firebase-admin");
const cors = require("cors");
const {
  computeHeatIndex,
  getHeatIndexLabel,
  getHeatIndexAdvisory,
} = require("./dss/heatIndex");
require("dotenv").config();
const { getHeatIndexAIResponse } = require("./services/openaiService");

// ------------------------------------------------------------
// 🔹 Initialize Express App
// ------------------------------------------------------------
const app = express();
app.use(cors());
app.use(express.json());

// ------------------------------------------------------------
// 🔹 Initialize Firebase Admin SDK
// ------------------------------------------------------------
const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
});

const db = admin.firestore();

// ------------------------------------------------------------
// 🔹 Utility Functions
// ------------------------------------------------------------

/**
 * Calculate average of numeric values
 */
function calculateAverage(values) {
  const valid = values.filter((v) => typeof v === "number" && !isNaN(v));

  if (valid.length === 0) return null;

  const sum = valid.reduce((acc, val) => acc + val, 0);
  return sum / valid.length;
}

/**
 * Extract thermal frame and compute min/max
 */
function processThermalData(docData) {
  if (!docData || !docData.frame || !Array.isArray(docData.frame)) {
    return null;
  }

  const frame = docData.frame;
  const width = docData.width;
  const height = docData.height;

  // If values were multiplied by 100 in ESP
  const processedFrame = frame
    .filter((v) => typeof v === "number" && !isNaN(v))
    .map((v) => v / 100);

  const min = Math.min(...processedFrame);
  const max = Math.max(...processedFrame);

  return {
    frame: processedFrame,
    width,
    height,
    min,
    max,
  };
}

/**
 * Get averaged sensor data for a room (Combined DSS)
 */
async function getRoomSensorData(roomName) {
  try {
    const frontRef = db.collection("sensorData").doc(`${roomName}_front`);
    const backRef = db.collection("sensorData").doc(`${roomName}_back`);

    const [frontSnap, backSnap] = await Promise.all([
      frontRef.get(),
      backRef.get(),
    ]);

    const temperatureValues = [];
    const humidityValues = [];

    // ---------- FRONT ----------
    if (frontSnap.exists) {
      const frontData = frontSnap.data();

      if (
        typeof frontData.Temperature === "number" &&
        !isNaN(frontData.Temperature)
      ) {
        temperatureValues.push(frontData.Temperature);
      }

      if (
        typeof frontData.Humidity === "number" &&
        !isNaN(frontData.Humidity)
      ) {
        humidityValues.push(frontData.Humidity);
      }
    }

    // ---------- BACK ----------
    if (backSnap.exists) {
      const backData = backSnap.data();

      if (
        typeof backData.Temperature === "number" &&
        !isNaN(backData.Temperature)
      ) {
        temperatureValues.push(backData.Temperature);
      }

      if (
        typeof backData.Humidity === "number" &&
        !isNaN(backData.Humidity)
      ) {
        humidityValues.push(backData.Humidity);
      }
    }

    // If both prototypes missing
    if (temperatureValues.length === 0 || humidityValues.length === 0) {
      console.warn(`⚠ No valid sensor values for ${roomName}`);
      return null;
    }

    // ---------- AVERAGE ----------
    const avgTemperature =
      temperatureValues.reduce((a, b) => a + b, 0) / temperatureValues.length;

    let avgHumidity =
      humidityValues.reduce((a, b) => a + b, 0) / humidityValues.length;

    // Clamp humidity to valid physical range
    avgHumidity = Math.min(Math.max(avgHumidity, 0), 100);

    // ---------- HEAT INDEX ----------
    let computedHeatIndex = null;
    let label = null;
    let advisory = null;

    if (avgTemperature !== null && avgHumidity !== null) {
      // If below NOAA threshold, heat index equals air temp
      computedHeatIndex = computeHeatIndex(avgTemperature, avgHumidity);

      label = getHeatIndexLabel(computedHeatIndex);
      advisory = getHeatIndexAdvisory(computedHeatIndex);
    }

    return {
      averageTemperature: Number(avgTemperature.toFixed(1)),
      averageHumidity: Number(avgHumidity.toFixed(1)),
      heatIndex: computedHeatIndex,
      label,
      advisory,
    };
  } catch (error) {
    console.error("❌ Error fetching sensor data:", error);
    return null;
  }
}

/**
 * Get thermal data for room
 */
async function getRoomThermalData(roomName) {
  try {
    const thermalRef = db.collection("thermalRooms").doc(roomName);
    const snapshot = await thermalRef.get();

    if (!snapshot.exists) {
      console.warn(`⚠ No thermal data found for ${roomName}`);
      return null;
    }

    const thermalData = snapshot.data();
    return processThermalData(thermalData);
  } catch (error) {
    console.error("❌ Error fetching thermal data:", error);
    return null;
  }
}

// * Build unified room response
async function buildRoomResponse(roomName) {
  const sensorData = await getRoomSensorData(roomName);
  const thermalData = await getRoomThermalData(roomName);

  if (!sensorData && !thermalData) {
    return null;
  }

  return {
    ...sensorData,
    thermal: thermalData,
    timestamp: Date.now(), // Backend timestamp
  };
}

// ------------------------------------------------------------
// 🔹 API Routes
// ------------------------------------------------------------

// * GET Room Data
app.get("/api/:roomName", async (req, res) => {
  const roomName = req.params.roomName;

  try {
    const roomData = await buildRoomResponse(roomName);

    if (!roomData) {
      return res.status(404).json({
        error: `No data found for room: ${roomName}`,
      });
    }

    return res.json({
      [roomName]: roomData,
    });
  } catch (error) {
    console.error("❌ API error:", error);
    return res.status(500).json({
      error: "Internal Server Error",
    });
  }
});

// * POST AI Heat Index Explanation
app.post("/api/ai/heat-index", async (req, res) => {
  try {
    const {
      temperature,
      humidity,
      heatIndex,
      label,
      advisory,
      question,
    } = req.body;

    if (!question) {
      return res.status(400).json({
        error: "Question is required.",
      });
    }

    const aiResponse = await getHeatIndexAIResponse({
      temperature,
      humidity,
      heatIndex,
      label,
      advisory,
      question,
    });

    return res.json({
      explanation: aiResponse,
    });
  } catch (error) {
    console.error("❌ AI Route error:", error);
    return res.status(500).json({
      error: "AI processing failed.",
    });
  }
});

// ------------------------------------------------------------
// 🔹 Start Server
// ------------------------------------------------------------
const PORT = process.env.PORT || 5000;

app.listen(PORT, () => {
  console.log(`🚀 Server running on http://localhost:${PORT}`);
});
