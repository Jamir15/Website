/**
 * ============================================================
 * Smart Building Monitoring System - Backend Server
 * ============================================================
 * Responsibilities:
 *  - Read sensor data from Firestore
 *  - Compute average temperature & humidity for Room 1
 *  - Compute heat index
 *  - Process thermal frame
 *  - Return unified room response
 *  - Export historical data logs to Excel on demand
 * ============================================================
 */

const express = require("express");
const admin = require("firebase-admin");
const cors = require("cors");
const compression = require("compression");
const ExcelJS = require("exceljs");
const {
  computeHeatIndex,
  getHeatIndexLabel,
  getHeatIndexAdvisory,
} = require("./dss/heatIndex");
require("dotenv").config();
const { getHeatIndexAIResponse } = require("./services/openaiService");

// ------------------------------------------------------------
// Initialize Express App
// ------------------------------------------------------------
const app = express();
app.use(compression()); // Enable gzip compression for weak WiFi
app.use(cors());
app.use(express.json());

// ------------------------------------------------------------
// Initialize Firebase Admin SDK
// ------------------------------------------------------------
const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
});

const db = admin.firestore();

// ------------------------------------------------------------
// Constants
// ------------------------------------------------------------
const ROOM1_SENSOR_DOCS = [
  { position: "front", docId: "room1_front" },
  { position: "back", docId: "room1_back" },
  { position: "left", docId: "room1_left" },
  { position: "right", docId: "room1_right" },
];

const ROOM1_LOG_COLLECTIONS = [
  { position: "front", collection: "room1_front_logs", sheet: "Room1 Front Logs" },
  { position: "back", collection: "room1_back_logs", sheet: "Room1 Back Logs" },
  { position: "left", collection: "room1_left_logs", sheet: "Room1 Left Logs" },
  { position: "right", collection: "room1_right_logs", sheet: "Room1 Right Logs" },
];

const TOTAL_ROOM1_NODES = ROOM1_SENSOR_DOCS.length;
const ROOM_REFRESH_INTERVAL_MS = 60000;
const roomResponseCache = {};

// ------------------------------------------------------------
// Utility Functions
// ------------------------------------------------------------

/**
 * Normalize Firestore timestamp to ISO string
 */
function formatFirestoreTimestamp(timestampValue) {
  if (!timestampValue) return "";

  if (typeof timestampValue.toDate === "function") {
    return timestampValue.toDate().toISOString();
  }

  if (timestampValue instanceof Date) {
    return timestampValue.toISOString();
  }

  if (typeof timestampValue === "string") {
    return timestampValue;
  }

  if (
    typeof timestampValue === "object" &&
    typeof timestampValue._seconds === "number"
  ) {
    return new Date(timestampValue._seconds * 1000).toISOString();
  }

  return "";
}

/**
 * Build monitoring status message
 */
function buildMonitoringStatusMessage(availableNodes, totalNodes) {
  if (availableNodes >= totalNodes) {
    return `Based on ${totalNodes} sensor positions`;
  }

  return `Degraded Monitoring: Running on ${availableNodes} of ${totalNodes} nodes`;
}

/**
 * Ensure monitoring status is always available at roomData.monitoring.Status
 * while keeping legacy roomData.monitoringStatus in sync.
 */
function normalizeMonitoringStatus(roomData) {
  if (!roomData || typeof roomData !== "object") {
    return roomData;
  }

  let status =
    roomData?.monitoring?.Status ||
    roomData?.monitoringStatus ||
    "";

  if (
    (typeof status !== "string" || !status.trim()) &&
    Number.isFinite(roomData.availableNodes) &&
    Number.isFinite(roomData.totalNodes)
  ) {
    status = buildMonitoringStatusMessage(
      roomData.availableNodes,
      roomData.totalNodes
    );
  }

  if (typeof status !== "string" || !status.trim()) {
    status = "Based on 4 sensor positions";
  }

  roomData.monitoring = {
    ...(roomData.monitoring || {}),
    Status: status,
  };
  roomData.monitoringStatus = status;

  return roomData;
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

  const processedFrame = frame
    .filter((v) => typeof v === "number" && !isNaN(v))
    .map((v) => v / 100);

  if (processedFrame.length === 0) {
    return null;
  }

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
 * Get averaged sensor data for Room 1 using front/back/left/right
 */
async function getRoomSensorData(roomName) {
  try {
    if (roomName !== "room1") {
      return null;
    }

    // Wrap Firestore queries with a timeout (4 seconds) to prevent hanging
    const queryTimeoutPromise = new Promise((_, reject) =>
      setTimeout(() => reject(new Error("Firestore query timeout")), 4000)
    );

    const queryProm = (async () => {
      const snapshots = await Promise.all(
        ROOM1_SENSOR_DOCS.map((node) =>
          db.collection("sensorData").doc(node.docId).get()
        )
      );
      return snapshots;
    })();

    const snapshots = await Promise.race([queryProm, queryTimeoutPromise]);

    const validNodeReadings = [];
    const nodeStatus = {};

    ROOM1_SENSOR_DOCS.forEach((node, index) => {
      const snap = snapshots[index];

      if (!snap.exists) {
        nodeStatus[node.position] = {
          available: false,
          temperature: null,
          humidity: null,
        };
        return;
      }

      const data = snap.data();

      const hasValidTemperature =
        typeof data.Temperature === "number" && !isNaN(data.Temperature);

      const hasValidHumidity =
        typeof data.Humidity === "number" && !isNaN(data.Humidity);

      if (hasValidTemperature && hasValidHumidity) {
        const safeHumidity = Math.min(Math.max(data.Humidity, 0), 100);

        validNodeReadings.push({
          position: node.position,
          temperature: data.Temperature,
          humidity: safeHumidity,
        });

        nodeStatus[node.position] = {
          available: true,
          temperature: Number(data.Temperature.toFixed(1)),
          humidity: Number(safeHumidity.toFixed(1)),
        };
      } else {
        nodeStatus[node.position] = {
          available: false,
          temperature: hasValidTemperature ? Number(data.Temperature.toFixed(1)) : null,
          humidity: hasValidHumidity ? Number(Math.min(Math.max(data.Humidity, 0), 100).toFixed(1)) : null,
        };
      }
    });

    const availableNodes = validNodeReadings.length;

    if (availableNodes === 0) {
      console.warn(`No valid sensor values for ${roomName}`);
      return null;
    }

    const avgTemperature =
      validNodeReadings.reduce((sum, item) => sum + item.temperature, 0) /
      availableNodes;

    const avgHumidity =
      validNodeReadings.reduce((sum, item) => sum + item.humidity, 0) /
      availableNodes;

    const roundedTemperature = Number(avgTemperature.toFixed(1));
    const roundedHumidity = Number(avgHumidity.toFixed(1));

    const computedHeatIndex = computeHeatIndex(
      roundedTemperature,
      roundedHumidity
    );
    const label = getHeatIndexLabel(computedHeatIndex);
    const advisory = getHeatIndexAdvisory(computedHeatIndex);

    const monitoringStatus = buildMonitoringStatusMessage(
      availableNodes,
      TOTAL_ROOM1_NODES
    );

    return {
      averageTemperature: roundedTemperature,
      averageHumidity: roundedHumidity,
      heatIndex: computedHeatIndex,
      label,
      advisory: Array.isArray(advisory)
        ? advisory
        : advisory
          ? [advisory]
          : ["No advisory available"],
      monitoringStatus,
      monitoring: {
        Status: monitoringStatus,
      },
      availableNodes,
      totalNodes: TOTAL_ROOM1_NODES,
      nodeStatus,
    };
  } catch (error) {
    console.error("Error fetching sensor data:", error);
    return null;
  }
}

/**
 * Get thermal data for room
 */
async function getRoomThermalData(roomName) {
  try {
    if (roomName !== "room1") {
      return null;
    }

    const thermalRef = db.collection("thermalRooms").doc(roomName);
    const snapshot = await thermalRef.get();

    if (!snapshot.exists) {
      console.warn(`No thermal data found for ${roomName}`);
      return null;
    }

    const thermalData = snapshot.data();
    return processThermalData(thermalData);
  } catch (error) {
    console.error("Error fetching thermal data:", error);
    return null;
  }
}

/**
 * Build unified room response
 */
async function buildRoomResponse(roomName) {
  const sensorData = await getRoomSensorData(roomName);
  const thermalData = await getRoomThermalData(roomName);

  if (!sensorData && !thermalData) {
    return null;
  }

  return {
    ...sensorData,
    thermal: thermalData,
    timestamp: Date.now(),
  };
}

/**
 * Refresh backend cache from Firestore every 5 seconds
 */
async function refreshRoomCache(roomName) {
  try {
    const roomData = await buildRoomResponse(roomName);
    if (roomData) {
      roomResponseCache[roomName] = normalizeMonitoringStatus(roomData);
    }
  } catch (error) {
    console.error(`Error refreshing cache for ${roomName}:`, error);
  }
}

function startRoomCachePolling(roomName) {
  refreshRoomCache(roomName);
  setInterval(() => refreshRoomCache(roomName), ROOM_REFRESH_INTERVAL_MS);
}

/**
 * Get historical logs for one Firestore collection
 */
async function getHistoricalLogs(collectionName, nodeName) {
  try {
    const snapshot = await db
      .collection(collectionName)
      .orderBy("timestamp", "asc")
      .get();

    return snapshot.docs.map((doc, index) => {
      const data = doc.data();

      return {
        logNumber: index + 1,
        nodeName,
        timestamp: formatFirestoreTimestamp(data.timestamp),
        temperature:
          typeof data.Temperature === "number"
            ? Number(data.Temperature.toFixed(1))
            : "",
        humidity:
          typeof data.Humidity === "number"
            ? Number(data.Humidity.toFixed(1))
            : "",
      };
    });
  } catch (error) {
    console.error(`Error fetching historical logs for ${collectionName}:`, error);
    throw error;
  }
}

/**
 * Add one worksheet for one historical logs collection
 */
function addHistoricalWorksheet(workbook, sheetName, rows) {
  const worksheet = workbook.addWorksheet(sheetName);

  worksheet.columns = [
    { header: "Log Number", key: "logNumber", width: 14 },
    { header: "Node Name", key: "nodeName", width: 18 },
    { header: "Timestamp", key: "timestamp", width: 28 },
    { header: "Temperature (°C)", key: "temperature", width: 18 },
    { header: "Humidity (%)", key: "humidity", width: 15 },
  ];

  worksheet.getRow(1).font = { bold: true };
  worksheet.views = [{ state: "frozen", ySplit: 1 }];

  if (rows.length === 0) {
    worksheet.addRow({
      logNumber: "",
      nodeName: "",
      timestamp: "No data available",
      temperature: "",
      humidity: "",
    });
    return;
  }

  rows.forEach((row) => worksheet.addRow(row));
}

// ------------------------------------------------------------
// API Routes
// ------------------------------------------------------------

/**
 * GET Room Data
 */
app.get("/api/:roomName", async (req, res) => {
  const roomName = req.params.roomName;

  // Set cache control headers - cache for 30 seconds
  res.set("Cache-Control", "public, max-age=30");
  res.set("Content-Type", "application/json; charset=utf-8");

  try {
    // Limit Firestore query to 5 seconds max
    const queryTimeoutPromise = new Promise((_, reject) =>
      setTimeout(() => reject(new Error("Query timeout")), 5000)
    );

    const dataProm = (async () => {
      const roomData =
        roomResponseCache[roomName] || (await buildRoomResponse(roomName));
      return roomData;
    })();

    const roomData = await Promise.race([dataProm, queryTimeoutPromise]);

    if (!roomData) {
      return res.status(404).json({
        error: `No data found for room: ${roomName}`,
      });
    }

    normalizeMonitoringStatus(roomData);

    return res.json({
      [roomName]: roomData,
    });
  } catch (error) {
    console.error("API error:", error);
    // Return 503 Service Unavailable for timeouts
    const statusCode = error.message === "Query timeout" ? 503 : 500;
    return res.status(statusCode).json({
      error: "Internal Server Error",
    });
  }
});

/**
 * POST AI Heat Index Explanation
 */
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
      room: "room1",
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
    console.error("AI Route error:", error);
    return res.status(500).json({
      error: "AI processing failed.",
    });
  }
});

/**
 * GET Export Historical Logs to Excel
 */
app.get("/api/export/historical-logs/excel", async (req, res) => {
  try {
    const workbook = new ExcelJS.Workbook();

    workbook.creator = "Smart Building Monitoring System";
    workbook.created = new Date();
    workbook.modified = new Date();

    for (const item of ROOM1_LOG_COLLECTIONS) {
      const rows = await getHistoricalLogs(
        item.collection,
        `room1_${item.position}`
      );
      addHistoricalWorksheet(workbook, item.sheet, rows);
    }

    const buffer = await workbook.xlsx.writeBuffer();

    res.setHeader(
      "Content-Type",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
    );
    res.setHeader(
      "Content-Disposition",
      'attachment; filename="historical_data_logs.xlsx"'
    );

    return res.send(Buffer.from(buffer));
  } catch (error) {
    console.error("Export route error:", error);
    return res.status(500).json({
      error: "Failed to export historical data logs.",
    });
  }
});

// ------------------------------------------------------------
// Start backend room cache polling
// ------------------------------------------------------------
startRoomCachePolling("room1");

// ------------------------------------------------------------
// Start Server
// ------------------------------------------------------------
const PORT = process.env.PORT || 5000;

app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
