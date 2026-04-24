/* =====================================================================
 * main.js – DSS Dashboard
 * Three.js viewer + Firestore real-time listener
 * Modern center monitoring layout with live floating sensor readings
 * ===================================================================== */
console.log("MAIN.JS IS RUNNING");

import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import {
  CSS2DRenderer,
  CSS2DObject,
} from "three/addons/renderers/CSS2DRenderer.js";
import { initializeApp } from "firebase/app";
import { getFirestore, doc, getDoc, onSnapshot } from "firebase/firestore";
import { Chart, registerables } from "chart.js/auto";
import { initAIChat, updateAIContext } from "./chatAi.js";

let backendDown = false;
let connectionQuality = "good"; // good, fair, poor
let consecutiveFailures = 0;
const MAX_RETRIES = 3;
const FETCH_TIMEOUT_MS = 8000;
let lastSuccessfulData = null;

Chart.register(...registerables);
const BACKEND_URL = "https://website-jbd4.onrender.com";
const REAL_ROOM_ID = "room1";

/* =====================================================================
 * DSS Functions - Heat Index Calculation
 * ===================================================================== */

function computeHeatIndex(tempC, humidity) {
  // Validate inputs
  if (
    typeof tempC !== "number" ||
    typeof humidity !== "number" ||
    isNaN(tempC) ||
    isNaN(humidity)
  ) {
    return null;
  }

  // Clamp humidity safely
  humidity = Math.max(0, Math.min(100, humidity));

  const T = (tempC * 9) / 5 + 32; // Celsius to Fahrenheit
  const R = humidity;

  let HI_F;

  // 1. Below 20°C -> Heat Index equals air temperature
  if (tempC < 20) {
    return Number(tempC.toFixed(1));
  }

  // 2. 20°C to below 26.7°C -> Steadman simple approximation
  if (tempC >= 20 && tempC < 26.7) {
    HI_F =
      0.5 *
      (T + 61.0 + (T - 68.0) * 1.2 + R * 0.094);

    // If result stays below 80°F, use Steadman result
    if (HI_F < 80) {
      const HI_C = ((HI_F - 32) * 5) / 9;
      return Number(Math.max(HI_C, tempC).toFixed(1));
    }
    // Otherwise continue to Rothfusz
  }

  // 3. Rothfusz regression
  HI_F =
    -42.379 +
    2.04901523 * T +
    10.14333127 * R -
    0.22475541 * T * R -
    0.00683783 * T * T -
    0.05481717 * R * R +
    0.00122874 * T * T * R +
    0.00085282 * T * R * R -
    0.00000199 * T * T * R * R;

  // Low humidity adjustment
  if (R < 13 && T >= 80 && T <= 112) {
    HI_F -= ((13 - R) / 4) * Math.sqrt((17 - Math.abs(T - 95)) / 17);
  }

  // High humidity adjustment
  if (R > 85 && T >= 80 && T <= 87) {
    HI_F += ((R - 85) / 10) * ((87 - T) / 5);
  }

  const HI_C = ((HI_F - 32) * 5) / 9;

  // Never allow HI to go below actual temperature
  return Number(Math.max(HI_C, tempC).toFixed(1));
}

function getHeatIndexLabel(heatIndex) {
  if (heatIndex == null) return null;

  if (heatIndex < 27) return "Normal";
  if (heatIndex < 33) return "Caution";
  if (heatIndex < 41.1) return "Extreme Caution";
  if (heatIndex < 52) return "Danger";
  return "Extreme Danger";
}

function getHeatIndexAdvisory(heatIndex) {
  if (heatIndex == null) return null;

  if (heatIndex < 27) {
    return ["Comfortable conditions. No heat-related risk."];
  }

  if (heatIndex < 33) {
    return [
      "27°C – 32°C : CAUTION",
      "• Possible fatigue with prolonged exposure",
      "• Low risk, but still uncomfortable",
    ];
  }

  if (heatIndex < 41.1) {
    return [
      "33°C – 41°C : EXTREME CAUTION",
      "• Higher chance of heat cramps",
      "• Possible heat exhaustion",
      "• Extra hydration and breaks needed",
      "• Vulnerable groups are more at risk",
    ];
  }

  if (heatIndex < 52) {
    return [
      "42°C – 51°C : DANGER",
      "• Likely heat cramps and heat exhaustion",
      "• Heat stroke becomes possible with prolonged exposure",
      "• Outdoor activities become risky",
      "• This level is often considered a suspension reference point in local heat advisories",
    ];
  }

  return [
    "52°C and above : EXTREME DANGER",
    "• Heat stroke highly likely",
    "• Very unsafe for prolonged exposure",
    "• Immediate protective measures required",
  ];
}

/* =====================================================================
 * UI Helpers
 * ===================================================================== */

function showToast(message, variant = "info") {
  let toast = document.getElementById("ui-toast");

  if (!toast) {
    toast = document.createElement("div");
    toast.id = "ui-toast";
    toast.className = "ui-toast";
    document.body.appendChild(toast);
  }

  toast.textContent = message;
  toast.classList.remove(
    "ui-toast--info",
    "ui-toast--success",
    "ui-toast--error",
  );
  toast.classList.add(`ui-toast--${variant}`);
  toast.classList.add("ui-toast--show");

  setTimeout(() => {
    toast.classList.remove("ui-toast--show");
  }, 3500);
}

/* =====================================================================
 * ASSISTANT CHAT COLLAPSE / EXPAND
 * ===================================================================== */

let isAssistantChatOpen = false;

function syncAssistantChatUI(open) {
  const toggleButton = document.getElementById("assistant-chat-toggle");
  const assistantPanel = document.getElementById("assistant-chat-panel");

  document.body.classList.toggle("assistant-chat-open", open);

  if (toggleButton) {
    toggleButton.setAttribute("aria-expanded", String(open));
    toggleButton.setAttribute(
      "aria-label",
      open ? "Close assistant chat" : "Open assistant chat",
    );
  }

  if (assistantPanel) {
    assistantPanel.setAttribute("aria-hidden", String(!open));
  }

  setTimeout(() => {
    window.dispatchEvent(new Event("resize"));
  }, 300);
}

function setAssistantChatOpen(open) {
  isAssistantChatOpen = open;
  syncAssistantChatUI(open);
}

function setupAssistantChatToggle() {
  const toggleButton = document.getElementById("assistant-chat-toggle");
  const closeButton = document.getElementById("assistant-chat-close");

  if (toggleButton) {
    toggleButton.addEventListener("click", () => {
      setAssistantChatOpen(true);
    });
  }

  if (closeButton) {
    closeButton.addEventListener("click", () => {
      setAssistantChatOpen(false);
    });
  }

  setAssistantChatOpen(false);
}

/* =====================================================================
 * AI SHARED STATE
 * ===================================================================== */

let latestAIContext = {
  room: null,
  temperature: null,
  humidity: null,
  heatIndex: null,
  label: null,
  advisory: null,
};

let worldTimeApiFailed = false;

/* =====================================================================
 * Firebase configuration
 * ===================================================================== */

const firebaseConfig = {
  apiKey: "AIzaSyCq6MUL63iHYpOrGqoQrWCjDPWhOnNajmQ",
  authDomain: "dss-database-51609.firebaseapp.com",
  projectId: "dss-database-51609",
  storageBucket: "dss-database-51609.firebasestorage.app",
  messagingSenderId: "514112370816",
  appId: "1:514112370816:web:46c160c80475164b98ce65",
  measurementId: "G-707NP59NVW",
};

const app = initializeApp(firebaseConfig);
const db = getFirestore(app);

/* =====================================================================
 * THERMAL FIRESTORE LISTENER
 * ===================================================================== */

const thermalDataByRoom = {};
const THERMAL_TIMEOUT_MS = 65000;
let thermalRecoveredOnce = {};

function initThermalRecoveryState(roomId) {
  if (!(roomId in thermalRecoveredOnce)) {
    thermalRecoveredOnce[roomId] = false;
  }
}

async function initializeThermalRoom(roomId) {
  if (!thermalDataByRoom[roomId]) {
    thermalDataByRoom[roomId] = {
      frame: null,
      ready: false,
      dirty: false,
      lastUpdateTime: 0,
      stale: false,
      restoreVisual: false,
    };
  }

  try {
    const ref = doc(db, "thermalRooms", roomId);
    const snap = await (async () => {
      const timeoutPromise = new Promise((_, reject) =>
        setTimeout(() => reject(new Error("Thermal fetch timeout")), 5000),
      );
      const docPromise = getDoc(ref);
      return Promise.race([docPromise, timeoutPromise]);
    })();

    if (snap.exists()) {
      const data = snap.data();
      if (Array.isArray(data.frame) && data.frame.length === 768) {
        const roomState = thermalDataByRoom[roomId];
        roomState.frame = data.frame;
        roomState.dirty = true;
        roomState.lastUpdateTime = Date.now();
        roomState.stale = false;
        roomState.ready = true;
        console.log(`Thermal system initialized for ${roomId} with last data`);
      }
    }
  } catch (error) {
    console.warn(`Failed to initialize thermal data for ${roomId}:`, error);
  }
}

function listenToThermal(roomId = REAL_ROOM_ID) {
  initThermalRecoveryState(roomId);
  initializeThermalRoom(roomId);

  const ref = doc(db, "thermalRooms", roomId);

  onSnapshot(ref, (snap) => {
    if (!snap.exists()) return;

    const data = snap.data();

    if (!Array.isArray(data.frame) || data.frame.length !== 768) {
      console.warn(`Invalid thermal frame for ${roomId}`);
      return;
    }

    if (!thermalDataByRoom[roomId]) {
      thermalDataByRoom[roomId] = {
        frame: null,
        ready: false,
        dirty: false,
        lastUpdateTime: 0,
        stale: false,
        restoreVisual: false,
      };
    }

    const roomState = thermalDataByRoom[roomId];
    const wasStale = roomState.stale;
    roomState.frame = data.frame;
    roomState.dirty = true;
    roomState.lastUpdateTime = Date.now();
    roomState.stale = false;

    if (wasStale && !thermalRecoveredOnce[roomId]) {
      console.info(`Thermal stream recovered for ${roomId}`);
      thermalRecoveredOnce[roomId] = true;
      roomState.restoreVisual = true;
    }

    if (!roomState.ready) {
      roomState.ready = true;
      console.log(`Thermal system ready for ${roomId}`);
    }
  });
}

/* =====================================================================
 * Fallback heat index
 * ===================================================================== */

function computeFallbackHeatIndex(tempC, humidity) {
  let HI = tempC;

  if (tempC >= 27) {
    HI = tempC + 0.05 * humidity;
  }

  if (HI < tempC) HI = tempC;
  if (HI > tempC + 3) HI = tempC + 3;

  return Number(HI.toFixed(1));
}

/* =====================================================================
 * ROOM SELECTION / VIEW STATE
 * ===================================================================== */

let activeRoom = REAL_ROOM_ID;
let isHeatmapEnabled = true;
let activeView = "dashboard";
let lastDashboardState = null;
let heatSlices = [];

function setActiveRoomBadge(roomName) {
  const badge = document.getElementById("active-room-badge");
  if (!badge) return;
  badge.textContent = roomName === "room2" ? "Room 2" : "Room 1";
}

function setActiveView(viewName) {
  const dashboardView = document.getElementById("dashboard-view");
  const settingsView = document.getElementById("settings-view");
  const aboutView = document.getElementById("about-view");
  const menuLinks = document.querySelectorAll(".menu-link");

  if (!dashboardView || !settingsView || !aboutView) return;

  activeView = viewName;
  const showSettings = viewName === "settings";
  const showAbout = viewName === "about";
  const showDashboard = !showSettings && !showAbout;

  dashboardView.classList.toggle("view-hidden", !showDashboard);
  settingsView.classList.toggle("view-hidden", !showSettings);
  aboutView.classList.toggle("view-hidden", !showAbout);

  menuLinks.forEach((link) => {
    const isActive = link.dataset.view === viewName;
    link.classList.toggle("active", isActive);
  });

  if (showDashboard) {
    requestAnimationFrame(() => {
      window.dispatchEvent(new Event("resize"));
      setTimeout(() => {
        window.dispatchEvent(new Event("resize"));
      }, 250);
    });
  }
}

function setConditionBannerPlaceholder(titleText, descText) {
  const banner = document.getElementById("condition-banner");
  const title = document.getElementById("condition-title");
  const desc = document.getElementById("condition-desc");
  if (!banner || !title || !desc) return;

  banner.classList.remove(
    "condition-normal",
    "condition-caution",
    "condition-extreme-caution",
    "condition-danger",
    "condition-extreme-danger",
  );
  banner.classList.add("condition-normal");

  title.textContent = titleText;
  desc.textContent = descText;
}

/* =====================================================================
 * SENSOR VISUAL STATE
 * ===================================================================== */

const SENSOR_KEYS = ["front", "back", "left", "right"];

const defaultSensorState = {
  front: {
    name: "Front Node",
    temperature: null,
    humidity: null,
    heatIndex: null,
    label: "Waiting Data",
    advisory: ["Waiting data..."],
  },
  back: {
    name: "Back Node",
    temperature: null,
    humidity: null,
    heatIndex: null,
    label: "Waiting Data",
    advisory: ["Waiting data..."],
  },
  left: {
    name: "Right Node",
    temperature: null,
    humidity: null,
    heatIndex: null,
    label: "Waiting Data",
    advisory: ["Waiting data..."],
  },
  right: {
    name: "Left Node",
    temperature: null,
    humidity: null,
    heatIndex: null,
    label: "Waiting Data",
    advisory: ["Waiting data..."],
  },
};

let latestSensorState = JSON.parse(JSON.stringify(defaultSensorState));

function formatMetricValue(value, unit = "") {
  const num = Number(value);
  if (Number.isFinite(num)) {
    return `${num.toFixed(1)}${unit ? ` ${unit}` : ""}`;
  }
  return `--${unit ? ` ${unit}` : ""}`;
}

function toAdvisoryArray(advisory) {
  if (Array.isArray(advisory)) return advisory;
  if (typeof advisory === "string" && advisory.trim()) return [advisory];
  return ["No advisory available."];
}

function readSensorCandidateFromRoomData(roomData, sensorKey, fallbackState = null) {
  if (!roomData || typeof roomData !== "object") return null;

  const avgLabel = roomData.label || "Waiting Data";
  const avgAdvisory = toAdvisoryArray(roomData.advisory);

  const candidateContainers = [
    roomData.sensorNodes,
    roomData.sensors,
    roomData.nodes,
    roomData.positions,
    roomData.positionData,
    roomData.nodeData,
    roomData.nodeStatus,
  ].filter(Boolean);

  const readCandidate = (candidate) => {
    if (!candidate || typeof candidate !== "object") return null;

    const temp =
      candidate.temperature ??
      candidate.temp ??
      candidate.airTemperature ??
      candidate.averageTemperature;

    const hum =
      candidate.humidity ??
      candidate.rh ??
      candidate.relativeHumidity ??
      candidate.averageHumidity;

    const hi =
      candidate.heatIndex ??
      candidate.heat_index ??
      candidate.hi ??
      candidate.calculatedHeatIndex;

    const label =
      candidate.label ??
      candidate.status ??
      candidate.risk ??
      candidate.category ??
      avgLabel;

    const advisory = candidate.advisory ?? candidate.message ?? avgAdvisory;

    return {
      temperature: Number(temp),
      humidity: Number(hum),
      heatIndex: Number(hi),
      label: label || avgLabel,
      advisory: toAdvisoryArray(advisory),
    };
  };

  for (const container of candidateContainers) {
    const direct = container[sensorKey];
    const alt =
      container[sensorKey.toUpperCase()] ||
      container[`${sensorKey}Node`] ||
      container[`${sensorKey}_node`] ||
      container[`${sensorKey}Sensor`] ||
      container[`${sensorKey}_sensor`];

    const found = readCandidate(direct || alt);
    if (found) return found;
  }

  if (fallbackState) {
    return {
      temperature: Number(fallbackState.temperature),
      humidity: Number(fallbackState.humidity),
      heatIndex: Number(fallbackState.heatIndex),
      label: fallbackState.label || avgLabel,
      advisory: toAdvisoryArray(fallbackState.advisory || avgAdvisory),
    };
  }

  return null;
}

function setSensorStateFromRoomData(roomData) {
  const avgTemp = Number(roomData.averageTemperature);
  const avgHum = Number(roomData.averageHumidity);
  const avgHi = Number(roomData.heatIndex);
  const avgLabel = roomData.label || "Waiting Data";
  const avgAdvisory = toAdvisoryArray(roomData.advisory);

  const nextState = JSON.parse(JSON.stringify(defaultSensorState));

  SENSOR_KEYS.forEach((key) => {
    nextState[key].temperature = Number.isFinite(avgTemp) ? avgTemp : null;
    nextState[key].humidity = Number.isFinite(avgHum) ? avgHum : null;
    nextState[key].heatIndex = Number.isFinite(avgHi) ? avgHi : null;
    nextState[key].label = avgLabel;
    nextState[key].advisory = avgAdvisory;
  });

  SENSOR_KEYS.forEach((key) => {
    const found = readSensorCandidateFromRoomData(roomData, key, nextState[key]);
    if (!found) return;

    if (Number.isFinite(found.temperature))
      nextState[key].temperature = found.temperature;
    if (Number.isFinite(found.humidity)) nextState[key].humidity = found.humidity;
    if (Number.isFinite(found.heatIndex)) nextState[key].heatIndex = found.heatIndex;
    nextState[key].label = found.label;
    nextState[key].advisory = found.advisory;
  });

  latestSensorState = nextState;

  if (threeApp) {
    threeApp.updateSensorVisuals(latestSensorState);
    threeApp.updateHeatFromRoomSensors(latestSensorState);
  }
}

function updateFrontSensorFromRoomData(roomData) {
  const currentFront = latestSensorState?.front || defaultSensorState.front;
  const nodeFront = roomData?.nodeStatus?.front || null;

  if (!nodeFront || !nodeFront.available) {
    return;
  }

  const frontTemperature = Number(
    nodeFront.temperature ?? nodeFront.temp ?? nodeFront.airTemperature,
  );
  const frontHumidity = Number(
    nodeFront.humidity ?? nodeFront.rh ?? nodeFront.relativeHumidity,
  );

  const nextState = {
    ...latestSensorState,
    front: {
      ...currentFront,
      temperature: Number.isFinite(frontTemperature)
        ? frontTemperature
        : currentFront.temperature,
      humidity: Number.isFinite(frontHumidity)
        ? frontHumidity
        : currentFront.humidity,
      heatIndex: currentFront.heatIndex,
      label: currentFront.label,
      advisory: currentFront.advisory,
    },
  };

  latestSensorState = nextState;

  if (threeApp) {
    threeApp.updateSensorVisuals(latestSensorState);
    threeApp.updateHeatFromRoomSensors(latestSensorState);
  }
}

function updateLeftSensorFromRoomData(roomData) {
  const currentLeft = latestSensorState?.left || defaultSensorState.left;
  const nodeLeft = roomData?.nodeStatus?.left || null;

  if (!nodeLeft || !nodeLeft.available) {
    return;
  }

  const leftTemperature = Number(
    nodeLeft.temperature ?? nodeLeft.temp ?? nodeLeft.airTemperature,
  );
  const leftHumidity = Number(
    nodeLeft.humidity ?? nodeLeft.rh ?? nodeLeft.relativeHumidity,
  );

  const nextState = {
    ...latestSensorState,
    left: {
      ...currentLeft,
      temperature: Number.isFinite(leftTemperature)
        ? leftTemperature
        : currentLeft.temperature,
      humidity: Number.isFinite(leftHumidity)
        ? leftHumidity
        : currentLeft.humidity,
      heatIndex: currentLeft.heatIndex,
      label: currentLeft.label,
      advisory: currentLeft.advisory,
    },
  };

  latestSensorState = nextState;

  if (threeApp) {
    threeApp.updateSensorVisuals(latestSensorState);
    threeApp.updateHeatFromRoomSensors(latestSensorState);
  }
}

function updateBackSensorFromRoomData(roomData) {
  const currentBack = latestSensorState?.back || defaultSensorState.back;
  const nodeBack = roomData?.nodeStatus?.back || null;

  if (!nodeBack || !nodeBack.available) {
    return;
  }

  const backTemperature = Number(
    nodeBack.temperature ?? nodeBack.temp ?? nodeBack.airTemperature,
  );
  const backHumidity = Number(
    nodeBack.humidity ?? nodeBack.rh ?? nodeBack.relativeHumidity,
  );

  const nextState = {
    ...latestSensorState,
    back: {
      ...currentBack,
      temperature: Number.isFinite(backTemperature)
        ? backTemperature
        : currentBack.temperature,
      humidity: Number.isFinite(backHumidity)
        ? backHumidity
        : currentBack.humidity,
      heatIndex: currentBack.heatIndex,
      label: currentBack.label,
      advisory: currentBack.advisory,
    },
  };

  latestSensorState = nextState;

  if (threeApp) {
    threeApp.updateSensorVisuals(latestSensorState);
    threeApp.updateHeatFromRoomSensors(latestSensorState);
  }
}

function updateRightSensorFromRoomData(roomData) {
  const currentRight = latestSensorState?.right || defaultSensorState.right;
  const nodeRight = roomData?.nodeStatus?.right || null;

  if (!nodeRight || !nodeRight.available) {
    return;
  }

  const rightTemperature = Number(
    nodeRight.temperature ?? nodeRight.temp ?? nodeRight.airTemperature,
  );
  const rightHumidity = Number(
    nodeRight.humidity ?? nodeRight.rh ?? nodeRight.relativeHumidity,
  );

  const nextState = {
    ...latestSensorState,
    right: {
      ...currentRight,
      temperature: Number.isFinite(rightTemperature)
        ? rightTemperature
        : currentRight.temperature,
      humidity: Number.isFinite(rightHumidity)
        ? rightHumidity
        : currentRight.humidity,
      heatIndex: currentRight.heatIndex,
      label: currentRight.label,
      advisory: currentRight.advisory,
    },
  };

  latestSensorState = nextState;

  if (threeApp) {
    threeApp.updateSensorVisuals(latestSensorState);
    threeApp.updateHeatFromRoomSensors(latestSensorState);
  }
}

function setReservedSensorVisualState() {
  latestSensorState = {
    front: {
      name: "Front Node",
      temperature: null,
      humidity: null,
      heatIndex: null,
      label: "Reserved",
      advisory: ["Room 2 is reserved for future expansion."],
    },
    back: {
      name: "Back Node",
      temperature: null,
      humidity: null,
      heatIndex: null,
      label: "Reserved",
      advisory: ["Room 2 is reserved for future expansion."],
    },
    left: {
      name: "Right Node",
      temperature: null,
      humidity: null,
      heatIndex: null,
      label: "Reserved",
      advisory: ["Room 2 is reserved for future expansion."],
    },
    right: {
      name: "Left Node",
      temperature: null,
      humidity: null,
      heatIndex: null,
      label: "Reserved",
      advisory: ["Room 2 is reserved for future expansion."],
    },
  };

  if (threeApp) {
    threeApp.updateSensorVisuals(latestSensorState);
    threeApp.updateHeatFromRoomSensors(latestSensorState);
  }
}

function showReservedRoom2View() {
  document.getElementById("temp-val").textContent = "--";
  document.getElementById("hum-val").textContent = "--";
  document.getElementById("hi-val").textContent = "--";

  setAlertBannerVisible(false);
  setConditionBannerPlaceholder("Reserved", "");
  setActiveRoomBadge("room2");
  setReservedSensorVisualState();

  document.getElementById("dss-title").innerHTML =
    `Room 2 Status: <span style="color:#2563eb; font-size:1.2em; font-weight:bold;">Reserved for Future Expansion</span>`;

  const dssBox = document.getElementById("dss-content");
  dssBox.replaceChildren(
    ...[
      "Reserved for future expansion.",
      "The architecture supports multi-room deployment through the same backend, Firestore, and dashboard structure.",
    ].map((line) => {
      const p = document.createElement("p");
      p.textContent = line;
      return p;
    }),
  );

  const sourceLeft = document.getElementById("dss-source-left");
  const sourceRight = document.getElementById("viewer-monitoring-status");
  if (sourceLeft) sourceLeft.textContent = "";
  if (sourceRight) {
    sourceRight.textContent = "Scalable multi-room dashboard architecture";
  }
}

function setupRoomClickHandlers() {
  const roomLinks = document.querySelectorAll(".room-link");

  roomLinks.forEach((link) => {
    link.addEventListener("click", (e) => {
      e.preventDefault();

      roomLinks.forEach((l) => l.classList.remove("active"));
      link.classList.add("active");

      activeRoom = link.dataset.room;
      setActiveView("dashboard");
      setActiveRoomBadge(activeRoom);
      console.log("Active room changed to:", activeRoom);

      if (activeRoom === "room2") {
        showReservedRoom2View();
        return;
      }

      if (lastDashboardState && activeRoom === REAL_ROOM_ID) {
        updateDashboard(
          lastDashboardState.temp,
          lastDashboardState.humidity,
          lastDashboardState.hi,
          lastDashboardState.label,
          lastDashboardState.advisory,
          lastDashboardState.monitoringStatus,
          lastDashboardState.roomData || null,
        );
      } else {
        document.getElementById("dss-content").innerHTML =
          `<p>Loading live data for <b>${activeRoom.toUpperCase()}</b>...</p>`;

        const sourceLeft = document.getElementById("dss-source-left");
        const sourceRight = document.getElementById("viewer-monitoring-status");
        if (sourceLeft) {
          sourceLeft.textContent =
            "Based on CDRRMO Heat Index Threshold Guidelines";
        }
        if (sourceRight) {
          sourceRight.textContent = "Based on 4 sensor positions";
        }
      }

      if (!thermalDataByRoom[REAL_ROOM_ID]) {
        listenToThermal(REAL_ROOM_ID);
      }
    });
  });
}

function setupMenuClickHandlers() {
  const menuLinks = document.querySelectorAll(".menu-link");

  menuLinks.forEach((link) => {
    link.addEventListener("click", (e) => {
      e.preventDefault();
      const targetView = link.dataset.view;

      if (targetView === "settings" || targetView === "about") {
        setActiveView(targetView);
      }
    });
  });
}

function setupDarkModeToggle() {
  const darkModeToggle = document.getElementById("darkmode-toggle");
  if (!darkModeToggle) return;

  let darkEnabled = false;
  try {
    darkEnabled = localStorage.getItem("dashboard-theme") === "dark";
  } catch (err) {
    console.warn("Could not read theme preference.", err);
  }

  document.body.classList.toggle("dark-mode", darkEnabled);
  darkModeToggle.checked = darkEnabled;

  darkModeToggle.addEventListener("change", (e) => {
    const enabled = e.target.checked;
    document.body.classList.toggle("dark-mode", enabled);
    try {
      localStorage.setItem("dashboard-theme", enabled ? "dark" : "light");
    } catch (err) {
      console.warn("Could not save theme preference.", err);
    }
  });
}

/* =====================================================================
 * Three.js viewer
 * ===================================================================== */

let threeApp = null;

function buildSensorLabelElement(sensorName) {
  const el = document.createElement("div");
  el.style.display = "flex";
  el.style.flexDirection = "column";
  el.style.gap = "4px";
  el.style.minWidth = "1px";
  el.style.padding = "8px 10px";
  el.style.borderRadius = "12px";
  el.style.background = "rgba(255,255,255,0.92)";
  el.style.border = "1px solid rgba(201,217,238,0.95)";
  el.style.boxShadow = "0 10px 22px rgba(16,34,58,0.14)";
  el.style.backdropFilter = "blur(8px)";
  el.style.pointerEvents = "none";
  el.style.userSelect = "none";
  el.style.fontFamily = "Segoe UI, Tahoma, Geneva, Verdana, sans-serif";

  const title = document.createElement("div");
  title.textContent = sensorName;
  title.style.fontSize = "11px";
  title.style.fontWeight = "700";
  title.style.letterSpacing = "0.06em";
  title.style.textTransform = "uppercase";
  title.style.color = "#55739b";

  const primary = document.createElement("div");
  primary.textContent = "-- °C";
  primary.style.fontSize = "16px";
  primary.style.fontWeight = "800";
  primary.style.color = "#102845";
  primary.style.lineHeight = "1.1";

  const secondary = document.createElement("div");
  secondary.textContent = "H --%";
  secondary.style.fontSize = "11px";
  secondary.style.fontWeight = "600";
  secondary.style.color = "#4d6788";
  secondary.style.lineHeight = "1.2";

  el.appendChild(title);
  el.appendChild(primary);
  el.appendChild(secondary);

  return { root: el, primary, secondary, title };
}

function initThreeJS() {
  const container = document.getElementById("canvas-container");
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0xffffff);

  const camera = new THREE.PerspectiveCamera(
    75,
    container.clientWidth / container.clientHeight,
    0.1,
    1000,
  );

  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(container.clientWidth, container.clientHeight);
  container.appendChild(renderer.domElement);

  const labelRenderer = new CSS2DRenderer();
  labelRenderer.setSize(container.clientWidth, container.clientHeight);
  labelRenderer.domElement.style.position = "absolute";
  labelRenderer.domElement.style.top = "0";
  labelRenderer.domElement.style.left = "0";
  labelRenderer.domElement.style.width = "100%";
  labelRenderer.domElement.style.height = "100%";
  labelRenderer.domElement.style.pointerEvents = "none";
  container.appendChild(labelRenderer.domElement);

  const ROOM_OFFSET_X = 0;
  const DEFAULT_TARGET = new THREE.Vector3(ROOM_OFFSET_X, 0.95, 0);
  const DEFAULT_CAMERA_POSITION = new THREE.Vector3(
    ROOM_OFFSET_X,
    4.5,
    9.2,
  );

  camera.position.copy(DEFAULT_CAMERA_POSITION);

  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.dampingFactor = 0.08;
  controls.rotateSpeed = 0.55;
  controls.zoomSpeed = 0.85;
  controls.panSpeed = 0.65;
  controls.screenSpacePanning = false;
  controls.enablePan = true;
  controls.minDistance = 1.2;
  controls.maxDistance = 15;
  controls.minPolarAngle = 0.6;
  controls.maxPolarAngle = 1.42;
  controls.target.copy(DEFAULT_TARGET);
  controls.update();

  const ROOM_WIDTH = 7.81;
  const ROOM_DEPTH = 6.92;
  const WALL_HEIGHT = 2.6;
  const FRONT_WALL_Z = -ROOM_DEPTH / 2;
  const DETACH_OFFSET = 0.05;

  let heatmapTexture = null;
  const heatmapCanvas = document.createElement("canvas");
  const HEATMAP_WIDTH = 128;
  const HEATMAP_HEIGHT = 96;
  heatmapCanvas.width = HEATMAP_WIDTH;
  heatmapCanvas.height = HEATMAP_HEIGHT;
  const heatmapCtx = heatmapCanvas.getContext("2d");
  heatmapCtx.imageSmoothingEnabled = false;

  // Perceptually-optimized thermal color mapping
  // Returns vibrant, saturated colors with pure red at critical temperatures
  function colorMapThermal(value, minValue, maxValue) {
    // Critical temperature threshold: 41.5°C = pure bright red (absolute, not relative)
    const CRITICAL_TEMP = 41.5;
    const isCritical = value >= CRITICAL_TEMP;

    // If critical, return pure bright red immediately
    if (isCritical) {
      return { r: 255, g: 0, b: 0 };
    }

    // Normalize temperature to 0-1 range
    let t = (value - minValue) / (maxValue - minValue);
    if (!isFinite(t)) t = 0;
    t = Math.max(0, Math.min(1, t));

    let r = 0, g = 0, b = 0;

    if (t < 0.2) {
      // Cool: Deep blue
      r = 0;
      g = 100 + t * 155 * 5; // 100 → 155
      b = 255 - t * 100 * 5; // 255 → 155
    } else if (t < 0.4) {
      // Moderate cool: Cyan to green
      const localT = (t - 0.2) / 0.2;
      r = 0;
      g = 200 + localT * 55;
      b = 155 - localT * 155;
    } else if (t < 0.6) {
      // Moderate warm: Green to yellow
      const localT = (t - 0.4) / 0.2;
      r = 255 * localT;
      g = 255;
      b = 0;
    } else if (t < 0.8) {
      // Warm: Yellow to orange
      const localT = (t - 0.6) / 0.2;
      r = 255;
      g = 255 - localT * 165; // 255 → 90
      b = 0;
    } else {
      // Hot: Orange to red
      const localT = (t - 0.8) / 0.2;
      r = 255;
      g = 90 - localT * 90; // 90 → 0
      b = 0;
    }

    return {
      r: Math.round(Math.max(0, Math.min(255, r))),
      g: Math.round(Math.max(0, Math.min(255, g))),
      b: Math.round(Math.max(0, Math.min(255, b))),
    };
  }

  function updateHeatFromFrontSensor(frame) {
    if (!frame || frame.length !== 768) return;

    let minT = Infinity;
    let maxT = -Infinity;
    for (const t of frame) {
      if (t < minT) minT = t;
      if (t > maxT) maxT = t;
    }
    if (maxT - minT < 2) maxT = minT + 2;

    const imageData = heatmapCtx.createImageData(32, 24);
    const data = imageData.data;

    for (let y = 0; y < 24; y++) {
      for (let x = 0; x < 32; x++) {
        const srcX = 31 - x;
        const srcY = 23 - y;
        const sensorIndex = srcY * 32 + srcX;

        const temp = frame[sensorIndex];
        const { r, g, b } = colorMapThermal(temp, minT, maxT);

        const pixelIndex = (y * 32 + x) * 4;
        data[pixelIndex + 0] = r;
        data[pixelIndex + 1] = g;
        data[pixelIndex + 2] = b;
        data[pixelIndex + 3] = 255;
      }
    }

    heatmapCtx.putImageData(imageData, 0, 0);
    heatmapCtx.imageSmoothingEnabled = false;
    heatmapTexture.needsUpdate = true;

    const now = Date.now();

    heatSlices.forEach((slice, index) => {
      const delay = index * HEAT_TIME_LAG_MS;
      if (now - slice.userData.lastUpdateTime < delay) return;

      const decayFactor = Math.exp(-HEAT_DECAY_PER_SLICE * index);
      slice.userData.targetOpacity = HEAT_MAX_OPACITY * decayFactor;
      slice.userData.targetEmissive = 0.6 * (decayFactor * decayFactor);

      if (!slice.material.map) {
        slice.material.map = heatmapTexture;
        slice.material.emissiveMap = heatmapTexture;
      }

      slice.userData.lastUpdateTime = now;
    });
  }

  function updateHeatFromRoomSensors(sensorState) {
    if (!sensorState) return false;

    const frontTemp = Number(sensorState.front?.temperature);
    const backTemp = Number(sensorState.back?.temperature);
    const leftTemp = Number(sensorState.left?.temperature);
    const rightTemp = Number(sensorState.right?.temperature);

    const hasAllSensorTemps =
      Number.isFinite(frontTemp) &&
      Number.isFinite(backTemp) &&
      Number.isFinite(leftTemp) &&
      Number.isFinite(rightTemp);

    if (!hasAllSensorTemps) return false;

    const minT = Math.min(frontTemp, backTemp, leftTemp, rightTemp);
    const maxT = Math.max(frontTemp, backTemp, leftTemp, rightTemp);
    const sensorRange = maxT - minT;
    const displayRange = Math.max(sensorRange, 0.4);
    const displayMid = (minT + maxT) / 2;
    const displayMin = displayMid - displayRange / 2;
    const displayMax = displayMid + displayRange / 2;

    const width = HEATMAP_WIDTH;
    const height = HEATMAP_HEIGHT;
    const imageData = heatmapCtx.createImageData(width, height);
    const data = imageData.data;

    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const nx = x / (width - 1);
        const ny = y / (height - 1);

        // Strong four-zone partition:
        // each sensor dominates its side of the room (front/back/left/right),
        // with only a thin blend line where zones meet.
        const rawFront = 1 - ny;
        const rawBack = ny;
        const rawLeft = 1 - nx;
        const rawRight = nx;

        const PARTITION_SHARPNESS = 10;
        const frontWeight = Math.pow(rawFront, PARTITION_SHARPNESS);
        const backWeight = Math.pow(rawBack, PARTITION_SHARPNESS);
        const leftWeight = Math.pow(rawLeft, PARTITION_SHARPNESS);
        const rightWeight = Math.pow(rawRight, PARTITION_SHARPNESS);

        const weightSum =
          frontWeight + backWeight + leftWeight + rightWeight;

        const interpolatedTemp =
          (
            frontTemp * frontWeight +
            backTemp * backWeight +
            leftTemp * leftWeight +
            rightTemp * rightWeight
          ) / weightSum;
        const { r, g, b } = colorMapThermal(
          interpolatedTemp,
          displayMin,
          displayMax,
        );

        const pixelIndex = (y * width + x) * 4;
        data[pixelIndex + 0] = r;
        data[pixelIndex + 1] = g;
        data[pixelIndex + 2] = b;
        data[pixelIndex + 3] = 255;
      }
    }

    heatmapCtx.putImageData(imageData, 0, 0);
    heatmapCtx.imageSmoothingEnabled = false;
    heatmapTexture.needsUpdate = true;

    const now = Date.now();

    heatSlices.forEach((slice, index) => {
      const delay = index * HEAT_TIME_LAG_MS;
      if (now - slice.userData.lastUpdateTime < delay) return;

      const decayFactor = Math.exp(-HEAT_DECAY_PER_SLICE * index);
      slice.userData.targetOpacity = HEAT_MAX_OPACITY * decayFactor;
      slice.userData.targetEmissive = 0.6 * (decayFactor * decayFactor);

      if (!slice.material.map) {
        slice.material.map = heatmapTexture;
        slice.material.emissiveMap = heatmapTexture;
      }

      slice.userData.lastUpdateTime = now;
    });

    return true;
  }

  const ambient = new THREE.AmbientLight(0xffffff, 1);
  scene.add(ambient);

  const dir = new THREE.DirectionalLight(0xffffff, 2);
  dir.position.set(5, 5, 5);
  scene.add(dir);

  heatmapTexture = new THREE.CanvasTexture(heatmapCanvas);
  heatmapTexture.minFilter = THREE.NearestFilter;
  heatmapTexture.magFilter = THREE.NearestFilter;
  heatmapTexture.generateMipmaps = false;

  const heatmapGeometry = new THREE.PlaneGeometry(
    ROOM_WIDTH * 0.9,
    WALL_HEIGHT * 0.9,
  );

  const HEAT_SLICE_COUNT = 12;
  const HEAT_SLICE_DEPTH = ROOM_DEPTH / HEAT_SLICE_COUNT;
  const HEAT_DECAY_PER_SLICE = 0.12;
  const HEAT_TIME_LAG_MS = 120;
  const HEAT_MAX_OPACITY = 0.85;
  const HEAT_BASE_OPACITY = 0.06;
  const HEAT_BASE_EMISSIVE = 0.02;
  const HEAT_TRANSITION_LERP = 0.12;

  heatSlices.length = 0;

  for (let i = 0; i < HEAT_SLICE_COUNT; i++) {
    const material = new THREE.MeshStandardMaterial({
      map: heatmapTexture,
      transparent: true,
      opacity: HEAT_BASE_OPACITY,
      side: THREE.DoubleSide,
      emissive: 0xffffff,
      emissiveMap: heatmapTexture,
      emissiveIntensity: HEAT_BASE_EMISSIVE,
    });

    const slice = new THREE.Mesh(heatmapGeometry, material);

    slice.position.set(
      ROOM_OFFSET_X,
      0.1,
      FRONT_WALL_Z + DETACH_OFFSET + i * HEAT_SLICE_DEPTH,
    );

    slice.renderOrder = i;
    slice.userData = {
      lastUpdateTime: 0,
      intensity: 0,
      targetOpacity: HEAT_BASE_OPACITY,
      targetEmissive: HEAT_BASE_EMISSIVE,
    };

    heatSlices.push(slice);
    scene.add(slice);
  }

  function animateHeatSlices() {
    heatSlices.forEach((slice) => {
      const targetOpacity =
        typeof slice.userData.targetOpacity === "number"
          ? slice.userData.targetOpacity
          : HEAT_BASE_OPACITY;
      const targetEmissive =
        typeof slice.userData.targetEmissive === "number"
          ? slice.userData.targetEmissive
          : HEAT_BASE_EMISSIVE;

      slice.material.opacity +=
        (targetOpacity - slice.material.opacity) * HEAT_TRANSITION_LERP;
      slice.material.emissiveIntensity +=
        (targetEmissive - slice.material.emissiveIntensity) *
        HEAT_TRANSITION_LERP;
    });
  }

  /* -------------------------------------------------
     LIVE SENSOR MARKERS + FLOATING LABELS
  -------------------------------------------------- */

  const sensorGroup = new THREE.Group();
  sensorGroup.position.x = ROOM_OFFSET_X;
  scene.add(sensorGroup);

  const markerGeometry = new THREE.SphereGeometry(0.06, 24, 24);
  const markerLineMaterial = new THREE.LineBasicMaterial({
    color: 0x86a9d8,
    transparent: true,
    opacity: 0.85,
  });

  const sensorPositions = {
    front: new THREE.Vector3(0, 0.9, -2.1),
    back: new THREE.Vector3(0, 0.9, 2.05),
    left: new THREE.Vector3(-2.45, 0.9, 0),
    right: new THREE.Vector3(2.45, 0.9, 0),
  };

  const sensorMarkers = {};

  function getMarkerColorByLabel(label) {
    switch (label) {
      case "Normal":
        return 0x2e9d5b;
      case "Caution":
        return 0xf1c40f;
      case "Extreme Caution":
        return 0xff8c00;
      case "Danger":
        return 0xe74c3c;
      case "Extreme Danger":
        return 0xb91c1c;
      case "Reserved":
        return 0x2563eb;
      default:
        return 0x3b82f6;
    }
  }

  function createSensorMarker(sensorKey) {
    const readable =
      sensorKey.charAt(0).toUpperCase() + sensorKey.slice(1) + " Node";

    const material = new THREE.MeshStandardMaterial({
      color: 0x3b82f6,
      emissive: 0x204f9c,
      emissiveIntensity: 0.45,
      roughness: 0.32,
      metalness: 0.12,
    });

    const mesh = new THREE.Mesh(markerGeometry, material);
    mesh.position.copy(sensorPositions[sensorKey]);
    mesh.userData.baseY = sensorPositions[sensorKey].y;
    sensorGroup.add(mesh);

    const linePoints = [
      new THREE.Vector3(0, -0.55, 0),
      new THREE.Vector3(0, -0.08, 0),
    ];
    const lineGeometry = new THREE.BufferGeometry().setFromPoints(linePoints);
    const line = new THREE.Line(lineGeometry, markerLineMaterial);
    mesh.add(line);

    const labelPieces = buildSensorLabelElement(readable);
    const labelObject = new CSS2DObject(labelPieces.root);
    labelObject.position.set(0, 0.22, 0);
    mesh.add(labelObject);

    sensorMarkers[sensorKey] = {
      mesh,
      line,
      labelObject,
      labelPrimary: labelPieces.primary,
      labelSecondary: labelPieces.secondary,
      labelTitle: labelPieces.title,
    };
  }

  SENSOR_KEYS.forEach(createSensorMarker);

  function updateSensorVisuals(sensorState) {
    SENSOR_KEYS.forEach((key) => {
      const marker = sensorMarkers[key];
      const state = sensorState[key];
      if (!marker || !state) return;

      const color = getMarkerColorByLabel(state.label);
      marker.mesh.material.color.setHex(color);
      marker.mesh.material.emissive.setHex(color);
      marker.mesh.material.emissiveIntensity = 0.45;

      marker.labelTitle.textContent = state.name;
      marker.labelPrimary.textContent = formatMetricValue(
        state.temperature,
        "°C",
      );
      marker.labelSecondary.textContent = `H ${formatMetricValue(
        state.humidity,
        "%",
      )}`;

      marker.labelObject.element.style.transform = "scale(1)";
      marker.labelObject.element.style.borderColor =
        "rgba(201,217,238,0.95)";
      marker.labelObject.element.style.boxShadow =
        "0 10px 22px rgba(16,34,58,0.14)";
    });
  }

  /* -------------------------------------------------
     GLB LOADER
  -------------------------------------------------- */

  async function loadGLBModel() {
    const GLB_URL =
      "https://firebasestorage.googleapis.com/v0/b/dss-database-51609.firebasestorage.app/o/classroom.glb?alt=media&token=caa4c4ed-3241-4a78-95c5-b1ea4947832a";
    const GLB_CACHE_KEY = "glb_model_cache";
    const GLB_CACHE_VERSION = 1;
    const GLB_CACHE_DB = "glb_cache_db";
    const GLB_CACHE_STORE = "models";
    const GLB_CACHE_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
    const LOAD_TIMEOUT_MS = 120000;

    function openGLBCacheDB() {
      return new Promise((resolve, reject) => {
        const request = indexedDB.open(GLB_CACHE_DB, 1);
        request.onupgradeneeded = () => {
          const db = request.result;
          if (!db.objectStoreNames.contains(GLB_CACHE_STORE)) {
            db.createObjectStore(GLB_CACHE_STORE);
          }
        };
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
    }

    async function getCachedModel() {
      try {
        const db = await openGLBCacheDB();
        return await new Promise((resolve, reject) => {
          const tx = db.transaction(GLB_CACHE_STORE, "readonly");
          const store = tx.objectStore(GLB_CACHE_STORE);
          const request = store.get(GLB_CACHE_KEY);

          request.onsuccess = () => {
            const cached = request.result;
            if (cached) {
              const cacheAge = Date.now() - cached.timestamp;
              if (
                cached.version === GLB_CACHE_VERSION &&
                cacheAge < GLB_CACHE_MAX_AGE_MS &&
                cached.data instanceof ArrayBuffer
              ) {
                console.log("Loading GLB from cache");
                resolve(cached.data);
                return;
              }
            }
            resolve(null);
          };

          request.onerror = () => reject(request.error);
          tx.oncomplete = () => db.close();
          tx.onerror = () => db.close();
        });
      } catch (err) {
        console.warn("Could not read GLB cache:", err);
      }
      return null;
    }

    async function cacheModel(arrayBuffer) {
      try {
        const db = await openGLBCacheDB();
        await new Promise((resolve, reject) => {
          const tx = db.transaction(GLB_CACHE_STORE, "readwrite");
          const store = tx.objectStore(GLB_CACHE_STORE);
          store.put(
            {
              version: GLB_CACHE_VERSION,
              data: arrayBuffer,
              timestamp: Date.now(),
            },
            GLB_CACHE_KEY,
          );
          tx.oncomplete = () => {
            db.close();
            resolve();
          };
          tx.onerror = () => {
            db.close();
            reject(tx.error);
          };
        });
        console.log("GLB model cached");
      } catch (err) {
        console.warn("Could not cache GLB model:", err);
      }
    }

    async function fetchGLBWithTimeout(url, retryCount = 0) {
      return new Promise((resolve, reject) => {
        const xhr = new XMLHttpRequest();

        xhr.open("GET", url, true);
        xhr.responseType = "arraybuffer";
        xhr.timeout = LOAD_TIMEOUT_MS;

        xhr.onprogress = (event) => {
          if (event.lengthComputable) {
            const percentComplete = Math.round(
              (event.loaded / event.total) * 100,
            );
            if (loadingOverlay) {
              loadingOverlay.textContent = `Loading 3D Model... ${percentComplete}%`;
            }
          }
        };

        xhr.onload = () => {
          if (xhr.status >= 200 && xhr.status < 300) {
            resolve(xhr.response);
          } else {
            reject(new Error(`HTTP ${xhr.status}`));
          }
        };

        xhr.onerror = () => reject(new Error("Network error"));
        xhr.ontimeout = () => reject(new Error("Download timeout"));
        xhr.send();
      }).catch(async (error) => {
        console.warn(
          `GLB fetch attempt ${retryCount + 1} failed:`,
          error.message,
        );
        if (loadingOverlay) {
          loadingOverlay.textContent = `Retrying... (weak WiFi detected)`;
        }

        const backoffMs = Math.min(Math.pow(2, retryCount) * 2000, 30000);
        await new Promise((resolve) => setTimeout(resolve, backoffMs));
        return fetchGLBWithTimeout(url, retryCount + 1);
      });
    }

    function parseGLB(arrayBuffer) {
      return new Promise((resolve, reject) => {
        const loader = new GLTFLoader();
        loader.parse(arrayBuffer, "", (gltf) => resolve(gltf), reject);
      });
    }

    const loadingOverlay = document.getElementById("loading-overlay");

    function createPlaceholder() {
      const group = new THREE.Group();

      const boxGeometry = new THREE.BoxGeometry(7, 2.6, 6.5);
      const boxMaterial = new THREE.MeshStandardMaterial({
        color: 0x888888,
        wireframe: false,
        roughness: 0.6,
        metalness: 0.1,
      });
      const boxMesh = new THREE.Mesh(boxGeometry, boxMaterial);
      boxMesh.position.set(ROOM_OFFSET_X, 0.3, 0);
      group.add(boxMesh);

      const edges = new THREE.EdgesGeometry(boxGeometry);
      const lineSegments = new THREE.LineSegments(
        edges,
        new THREE.LineBasicMaterial({ color: 0x333333 }),
      );
      lineSegments.position.set(ROOM_OFFSET_X, 0.3, 0);
      group.add(lineSegments);

      return group;
    }

    const placeholder = createPlaceholder();
    scene.add(placeholder);

    try {
      let glbData = await getCachedModel();
      let isFromCache = true;

      if (!glbData) {
        isFromCache = false;
        if (loadingOverlay) {
          loadingOverlay.textContent = "Loading 3D Model...";
        }
        glbData = await fetchGLBWithTimeout(GLB_URL);
        await cacheModel(glbData);
      }

      if (loadingOverlay && !isFromCache) {
        loadingOverlay.textContent = "Parsing 3D Model... 99%";
      }
      const gltf = await parseGLB(glbData);

      if (loadingOverlay) {
        loadingOverlay.style.display = "none";
      }

      scene.remove(placeholder);

      const model = gltf.scene;
      const box = new THREE.Box3().setFromObject(model);
      const center = box.getCenter(new THREE.Vector3());
      model.position.sub(center);
      model.position.x += ROOM_OFFSET_X;
      scene.add(model);

      const size = box.getSize(new THREE.Vector3());
      const maxDim = Math.max(size.x, size.y, size.z) || 7;

      camera.position.set(
        ROOM_OFFSET_X,
        Math.max(4.5, size.y * 0.95 + 2.0),
        Math.max(8.0, maxDim * 1.35),
      );

      controls.target.set(
        ROOM_OFFSET_X,
        Math.max(0.85, size.y * 0.34),
        0,
      );

      controls.minDistance = Math.max(1.2, maxDim * 0.18);
      controls.maxDistance = Math.max(15, maxDim * 2.3);
      controls.update();

      console.log("GLB model loaded successfully");
    } catch (error) {
      console.error("GLB load failed:", error);
      if (loadingOverlay) {
        loadingOverlay.textContent =
          "Model Load Failed. Check your WiFi connection.";
        loadingOverlay.style.color = "#ef4444";
      }
    }
  }

  loadGLBModel();

  window.addEventListener("resize", () => {
    const width = container.clientWidth;
    const height = container.clientHeight;
    camera.aspect = width / height;
    camera.updateProjectionMatrix();
    renderer.setSize(width, height);
    labelRenderer.setSize(width, height);
  });

  let lastThermalLoopTime = 0;
  const THERMAL_LOOP_INTERVAL_MS = 30000;
  let lastSensorHeatSignature = "";

  function updateThermalVisuals(now) {
    const roomState = thermalDataByRoom[REAL_ROOM_ID];
    const sensorHeatSignature = SENSOR_KEYS.map((key) => {
      const temp = Number(latestSensorState?.[key]?.temperature);
      return Number.isFinite(temp) ? temp.toFixed(2) : "na";
    }).join("|");
    const hasSensorDrivenUpdate = sensorHeatSignature !== lastSensorHeatSignature;
    const hasImmediateDirtyFrame =
      !!roomState && roomState.dirty && Array.isArray(roomState.frame);

    if (
      !hasSensorDrivenUpdate &&
      !hasImmediateDirtyFrame &&
      now - lastThermalLoopTime < THERMAL_LOOP_INTERVAL_MS
    ) {
      return;
    }
    lastThermalLoopTime = now;
    lastSensorHeatSignature = sensorHeatSignature;

    if (activeRoom !== REAL_ROOM_ID) {
      heatSlices.forEach((slice) => {
        slice.visible = false;
      });
      Object.values(sensorMarkers).forEach((marker) => {
        marker.mesh.visible = false;
      });
      return;
    }

    Object.values(sensorMarkers).forEach((marker) => {
      marker.mesh.visible = true;
    });

    if (!roomState) {
      heatSlices.forEach((slice) => {
        slice.visible = isHeatmapEnabled;
        slice.userData.targetOpacity = HEAT_BASE_OPACITY;
        slice.userData.targetEmissive = HEAT_BASE_EMISSIVE;
      });
      if (isHeatmapEnabled) {
        updateHeatFromRoomSensors(latestSensorState);
      }
      return;
    }

    if (roomState.ready && now - roomState.lastUpdateTime > THERMAL_TIMEOUT_MS) {
      if (!roomState.stale) {
        roomState.stale = true;
        console.warn(`Thermal watchdog: ${REAL_ROOM_ID} data stream stale`);
      }
    }

    heatSlices.forEach((slice) => {
      slice.visible = isHeatmapEnabled;
    });

    if (isHeatmapEnabled) {
      const updatedFromSensors = updateHeatFromRoomSensors(latestSensorState);

      if (!updatedFromSensors && !roomState.stale && roomState.dirty && roomState.frame) {
        updateHeatFromFrontSensor(roomState.frame);
        roomState.dirty = false;
      }
    }

    if (roomState.restoreVisual) {
      roomState.dirty = true;
      roomState.restoreVisual = false;
    }
  }

  function animate() {
    requestAnimationFrame(animate);
    const now = Date.now();

    updateThermalVisuals(now);
    animateHeatSlices();

    Object.keys(sensorMarkers).forEach((key, idx) => {
      const marker = sensorMarkers[key];
      const baseY = marker.mesh.userData.baseY;
      marker.mesh.position.y = baseY + Math.sin(now * 0.0018 + idx) * 0.015;
    });

    controls.update();
    renderer.render(scene, camera);
    labelRenderer.render(scene, camera);
  }

  animate();
  updateSensorVisuals(latestSensorState);
  updateHeatFromRoomSensors(latestSensorState);

  return {
    updateSensorVisuals,
    updateHeatFromRoomSensors,
  };
}

/* =====================================================================
 * Notification Banner for Extreme Heat Index
 * ===================================================================== */

let isAlertBannerVisible = false;
let alertBannerAutoHideTimer = null;

function setAlertBannerVisible(visible, message) {
  const banner = document.getElementById("alert-banner");
  const msg = document.getElementById("alert-message");
  if (!banner || !msg) return;

  if (visible) {
    if (alertBannerAutoHideTimer) {
      clearTimeout(alertBannerAutoHideTimer);
      alertBannerAutoHideTimer = null;
    }
    if (message) msg.textContent = message;
    if (!isAlertBannerVisible) {
      banner.classList.remove("hidden");
      banner.classList.add("show");
      isAlertBannerVisible = true;
    }
    return;
  }

  if (isAlertBannerVisible) {
    banner.classList.remove("show");
    banner.classList.add("hidden");
    isAlertBannerVisible = false;
  }

  if (alertBannerAutoHideTimer) {
    clearTimeout(alertBannerAutoHideTimer);
    alertBannerAutoHideTimer = null;
  }
}

document.addEventListener("keydown", (e) => {
  if (e.shiftKey && e.key === "N") {
    const currentHi = Number(latestAIContext.heatIndex);
    const shouldPersist = !Number.isNaN(currentHi) && currentHi >= 41.1;

    setAlertBannerVisible(
      true,
      "⚠️Warning: Heat Index is greater than 41°C",
    );

    if (!shouldPersist) {
      alertBannerAutoHideTimer = setTimeout(() => {
        setAlertBannerVisible(false);
      }, 30000);
    }
  }
});

/* =====================================================================
 * Peak Heat Hours
 * ===================================================================== */

let isPeakBannerVisible = false;
let peakBannerAutoHideTimer = null;

function setPeakBannerVisible(visible) {
  const banner = document.getElementById("peak-heat-banner");
  if (!banner) return;

  if (visible) {
    if (peakBannerAutoHideTimer) {
      clearTimeout(peakBannerAutoHideTimer);
      peakBannerAutoHideTimer = null;
    }
    if (!isPeakBannerVisible) {
      banner.classList.remove("hidden");
      banner.classList.add("show");
      isPeakBannerVisible = true;
    }
    return;
  }

  if (isPeakBannerVisible) {
    banner.classList.remove("show");
    banner.classList.add("hidden");
    isPeakBannerVisible = false;
  }

  if (peakBannerAutoHideTimer) {
    clearTimeout(peakBannerAutoHideTimer);
    peakBannerAutoHideTimer = null;
  }
}

function checkPeakHeatHours() {
  const now = new Date();
  const hour = now.getHours();

  const inPeakHours = hour >= 11 && hour < 16;
  setPeakBannerVisible(inPeakHours);

  return inPeakHours;
}

document.addEventListener("keydown", (e) => {
  if (e.shiftKey && e.key === "P") {
    const inPeakHours = checkPeakHeatHours();
    if (!inPeakHours) {
      setPeakBannerVisible(true);
      peakBannerAutoHideTimer = setTimeout(() => {
        setPeakBannerVisible(false);
      }, 30000);
    }
  }
});

/* =====================================================================
 * Dashboard updating
 * ===================================================================== */

function updateConditionBanner(hi) {
  const banner = document.getElementById("condition-banner");
  const title = document.getElementById("condition-title");
  const desc = document.getElementById("condition-desc");
  if (!banner || !title || !desc) return;

  const value = Number(hi);

  let state = "condition-normal";
  let titleText = "✅Normal";
  let descText = "Comfortable condition";

  if (value >= 52) {
    state = "condition-extreme-danger";
    titleText = "☠️Extreme Danger";
    descText = "Heat Index 52°C and above";
  } else if (value >= 42) {
    state = "condition-danger";
    titleText = "🔥Danger";
    descText = "Heat Index 42°C-51°C";
  } else if (value >= 33) {
    state = "condition-extreme-caution";
    titleText = "🔥Extreme Caution";
    descText = "Heat Index 33°C-41°C";
  } else if (value >= 27) {
    state = "condition-caution";
    titleText = "⚠️Caution";
    descText = "Heat Index 27°C-32°C";
  }

  banner.classList.remove(
    "condition-normal",
    "condition-caution",
    "condition-extreme-caution",
    "condition-danger",
    "condition-extreme-danger",
  );
  banner.classList.add(state);

  title.textContent = titleText;
  desc.textContent = descText;
}

function updateDashboard(
  temp,
  humidity,
  hi,
  label,
  advisory,
  monitoringStatus = "Based on 4 sensor positions",
  roomData = null,
) {
  hi = Number(hi) || 0;
  label = label || "UNKNOWN";

  if (Array.isArray(advisory)) {
    // keep as-is
  } else if (typeof advisory === "string") {
    advisory = [advisory];
  } else {
    advisory = ["No advisory available"];
  }

  lastDashboardState = {
    temp,
    humidity,
    hi,
    label,
    advisory,
    monitoringStatus,
    roomData,
  };

  const tempEl = document.getElementById("temp-val");
  const humEl = document.getElementById("hum-val");
  const hiEl = document.getElementById("hi-val");

  if (tempEl) tempEl.textContent = Number(temp).toFixed(1);
  if (humEl) humEl.textContent = Number(humidity).toFixed(1);
  if (hiEl) hiEl.textContent = Number(hi).toFixed(1);

  updateConditionBanner(hi);

  const shouldShowAlert = hi >= 41.1;
  if (shouldShowAlert) {
    setAlertBannerVisible(
      true,
      "⚠️Warning: Heat Index is greater than 41°C",
    );
  } else {
    setAlertBannerVisible(false);
  }

  let color = "black";

  switch (label) {
    case "Normal":
      color = "#28a745";
      break;
    case "Caution":
      color = "#ffc107";
      break;
    case "Extreme Caution":
      color = "#fd7e14";
      break;
    case "Danger":
      color = "#dc3545";
      break;
    case "Extreme Danger":
      color = "#721c24";
      break;
    case "ESTIMATED (FALLBACK)":
      color = "#6b7280";
      break;
  }

  const dssTitle = document.getElementById("dss-title");
  if (dssTitle) {
    dssTitle.innerHTML =
      `Heat Index Advisory (Decision Support System): <span style="color:${color}; font-size:1.15em; font-weight:bold;">${label}</span>`;
  }

  const dssBox = document.getElementById("dss-content");
  if (dssBox) {
    dssBox.replaceChildren(
      ...advisory.map((line) => {
        const p = document.createElement("p");
        p.textContent = String(line);
        return p;
      }),
    );
  }

  const dssSourceLeft = document.getElementById("dss-source-left");
  const dssSourceRight = document.getElementById("viewer-monitoring-status");
  if (dssSourceLeft) {
    dssSourceLeft.textContent =
      "Based on CDRRMO Heat Index Threshold Guidelines";
  }
  if (dssSourceRight) {
    dssSourceRight.textContent = monitoringStatus;
  }

  if (roomData) {
    setSensorStateFromRoomData(roomData);
  } else {
    setSensorStateFromRoomData({
      averageTemperature: temp,
      averageHumidity: humidity,
      heatIndex: hi,
      label,
      advisory,
    });
  }
}

/* =====================================================================
 * Charts
 * ===================================================================== */

let sensorChart = null;
let metricSparklines = {
  temp: null,
  hum: null,
  hi: null,
};
let chartData = {
  labels: [],
  temp: [],
  hum: [],
  hi: [],
};

function initSparkline() {
  const sensorCanvas = document.getElementById("sensorChart");
  if (!sensorCanvas) {
    sensorChart = null;
    return;
  }

  const ctx = sensorCanvas.getContext("2d");
  sensorChart = new Chart(ctx, {
    type: "line",
    data: {
      labels: chartData.labels,
      datasets: [
        {
          label: "Temperature (°C)",
          data: chartData.temp,
          borderColor: "rgba(255,0,0,0.8)",
          backgroundColor: "rgba(255,0,0,0.2)",
          borderWidth: 4,
          tension: 0.4,
          fill: false,
          pointRadius: 5,
        },
        {
          label: "Humidity (%)",
          data: chartData.hum,
          borderColor: "rgba(0,0,255,0.8)",
          backgroundColor: "rgba(0,0,255,0.2)",
          borderWidth: 4,
          tension: 0.4,
          fill: false,
          pointRadius: 5,
        },
        {
          label: "Heat Index (°C)",
          data: chartData.hi,
          borderColor: "rgba(255,165,0,0.8)",
          backgroundColor: "rgba(255,165,0,0.2)",
          borderWidth: 4,
          tension: 0.4,
          fill: false,
          pointRadius: 5,
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
    },
  });
}

function createMetricSparkline(canvasId, dataSource, lineColor, fillColor) {
  const canvas = document.getElementById(canvasId);
  if (!canvas) return null;

  const ctx = canvas.getContext("2d");

  return new Chart(ctx, {
    type: "line",
    data: {
      labels: chartData.labels,
      datasets: [
        {
          data: dataSource,
          borderColor: lineColor,
          backgroundColor: fillColor,
          borderWidth: 2,
          tension: 0.42,
          fill: true,
          pointRadius: 2,
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { display: false },
        tooltip: { enabled: false },
      },
      scales: {
        x: { display: false },
        y: { display: false },
      },
    },
  });
}

function initMetricSparklines() {
  metricSparklines.temp = createMetricSparkline(
    "temp-sparkline",
    chartData.temp,
    "rgba(255, 77, 79, 0.95)",
    "rgba(255, 77, 79, 0.18)",
  );

  metricSparklines.hum = createMetricSparkline(
    "hum-sparkline",
    chartData.hum,
    "rgba(64, 158, 255, 0.95)",
    "rgba(64, 158, 255, 0.16)",
  );

  metricSparklines.hi = createMetricSparkline(
    "hi-sparkline",
    chartData.hi,
    "rgba(255, 170, 66, 0.95)",
    "rgba(255, 170, 66, 0.16)",
  );
}

function updateSparkline(temp, hum, hi) {
  const ts = new Date().toLocaleTimeString();
  chartData.labels.push(ts);
  chartData.temp.push(temp);
  chartData.hum.push(hum);
  chartData.hi.push(hi);

  if (chartData.labels.length > 20) {
    chartData.labels.shift();
    chartData.temp.shift();
    chartData.hum.shift();
    chartData.hi.shift();
  }

  if (sensorChart) sensorChart.update();
  if (metricSparklines.temp) metricSparklines.temp.update();
  if (metricSparklines.hum) metricSparklines.hum.update();
  if (metricSparklines.hi) metricSparklines.hi.update();
}

/* =====================================================================
 * Backend listener
 * ===================================================================== */

async function fetchWithTimeout(url, timeoutMs = FETCH_TIMEOUT_MS) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: { "Cache-Control": "no-cache" },
    });
    clearTimeout(timeoutId);
    return response;
  } catch (error) {
    clearTimeout(timeoutId);
    throw error;
  }
}

function cacheSuccessfulData(data) {
  try {
    localStorage.setItem(
      "lastRoomData",
      JSON.stringify({
        data,
        timestamp: Date.now(),
      }),
    );
    lastSuccessfulData = data;
  } catch (err) {
    console.warn("Could not cache data to localStorage:", err);
  }
}

function getCachedData() {
  try {
    const cached = localStorage.getItem("lastRoomData");
    if (cached) {
      const parsed = JSON.parse(cached);
      const cacheAge = Date.now() - parsed.timestamp;
      const MAX_CACHE_AGE = 5 * 60 * 1000;

      if (cacheAge < MAX_CACHE_AGE) {
        return parsed.data;
      }
    }
  } catch (err) {
    console.warn("Could not retrieve cached data:", err);
  }
  return lastSuccessfulData;
}

async function fetchDataWithRetry(roomId, retryCount = 0) {
  try {
    const res = await fetchWithTimeout(
      `${BACKEND_URL}/api/${roomId}`,
      FETCH_TIMEOUT_MS,
    );

    if (!res.ok) {
      throw new Error(`HTTP ${res.status}`);
    }

    const json = await res.json();
    const roomData = json[roomId];
    if (!roomData) throw new Error("Invalid room data");

    const temp = Number(roomData.averageTemperature);
    const hum = Number(roomData.averageHumidity);
    const hi = Number(roomData.heatIndex);

    if (isNaN(temp) || isNaN(hum) || isNaN(hi)) {
      throw new Error("Invalid numeric values");
    }

    consecutiveFailures = 0;
    connectionQuality = "good";
    cacheSuccessfulData(roomData);
    return roomData;
  } catch (error) {
    console.warn(
      `Fetch attempt ${retryCount + 1}/${MAX_RETRIES} failed:`,
      error.message,
    );

    if (retryCount < MAX_RETRIES) {
      const backoffMs = Math.pow(2, retryCount) * 1000;
      await new Promise((resolve) => setTimeout(resolve, backoffMs));
      return fetchDataWithRetry(roomId, retryCount + 1);
    }

    throw error;
  }
}

function listenToData() {
  // Real-time listener for all 4 sensor documents
  const sensorStates = {
    front: null,
    back: null,
    left: null,
    right: null,
  };

  let thermalData = null;

  const processSensorData = () => {
    const validReadings = [];
    const nodeStatus = {};

    Object.entries(sensorStates).forEach(([position, sensorData]) => {
      if (sensorData && sensorData.available) {
        validReadings.push({
          position,
          temperature: sensorData.temperature,
          humidity: sensorData.humidity,
        });
        nodeStatus[position] = {
          available: true,
          temperature: sensorData.temperature,
          humidity: sensorData.humidity,
        };
      } else {
        nodeStatus[position] = {
          available: false,
          temperature: null,
          humidity: null,
        };
      }
    });

    if (validReadings.length === 0) {
      console.warn("No valid sensor readings available");
      return null;
    }

    const avgTemp =
      validReadings.reduce((sum, r) => sum + r.temperature, 0) /
      validReadings.length;
    const avgHum =
      validReadings.reduce((sum, r) => sum + r.humidity, 0) /
      validReadings.length;

    const roundedTemp = Number(avgTemp.toFixed(1));
    const roundedHum = Number(avgHum.toFixed(1));

    const heatIdx = computeHeatIndex(roundedTemp, roundedHum);
    const label = getHeatIndexLabel(heatIdx);
    const advisory = getHeatIndexAdvisory(heatIdx);

    const monitoringStatus =
      validReadings.length === 4
        ? "Based on 4 sensor positions"
        : `Degraded Monitoring: Running on ${validReadings.length} of 4 nodes`;

    return {
      averageTemperature: roundedTemp,
      averageHumidity: roundedHum,
      heatIndex: heatIdx,
      label,
      advisory: Array.isArray(advisory) ? advisory : [advisory],
      monitoringStatus,
      nodeStatus,
      thermal: thermalData,
      availableNodes: validReadings.length,
      totalNodes: 4,
    };
  };

  const updateFromSensorData = () => {
    try {
      if (activeRoom !== REAL_ROOM_ID) return;

      const roomData = processSensorData();
      if (!roomData) {
        console.warn("No room data to update dashboard");
        return;
      }

      backendDown = false;
      consecutiveFailures = 0;
      connectionQuality = "good";

      const temp = roomData.averageTemperature;
      const hum = roomData.averageHumidity;
      const hi = roomData.heatIndex;

      updateDashboard(
        temp,
        hum,
        hi,
        roomData.label,
        roomData.advisory,
        roomData.monitoringStatus,
        roomData,
      );
      updateSparkline(temp, hum, hi);

      latestAIContext = {
        room: REAL_ROOM_ID,
        temperature: temp,
        humidity: hum,
        heatIndex: hi,
        label: roomData.label,
        advisory: roomData.advisory,
      };

      updateAIContext({
        room: REAL_ROOM_ID,
        temperature: temp,
        humidity: hum,
        heatIndex: hi,
        label: roomData.label,
        advisory: roomData.advisory,
        backendDown: false,
        sensorsDown: false,
      });

      cacheSuccessfulData(roomData);
    } catch (err) {
      console.error("Error updating from sensor data:", err);
    }
  };

  // Listen to each sensor document in real-time
  const sensorPositions = ["front", "back", "left", "right"];
  const sensorDocIds = {
    front: "room1_front",
    back: "room1_back",
    left: "room1_left",
    right: "room1_right",
  };

  sensorPositions.forEach((position) => {
    const docRef = doc(db, "sensorData", sensorDocIds[position]);
    onSnapshot(
      docRef,
      (snap) => {
        if (snap.exists()) {
          const data = snap.data();
          const temp = Number(data.Temperature);
          const hum = Number(Math.min(Math.max(data.Humidity, 0), 100));

          if (Number.isFinite(temp) && Number.isFinite(hum)) {
            sensorStates[position] = {
              available: true,
              temperature: Number(temp.toFixed(1)),
              humidity: Number(hum.toFixed(1)),
            };
          } else {
            sensorStates[position] = {
              available: false,
              temperature: null,
              humidity: null,
            };
          }
        } else {
          sensorStates[position] = {
            available: false,
            temperature: null,
            humidity: null,
          };
        }

        updateFromSensorData();
      },
      (error) => {
        console.warn(
          `Error listening to sensor ${position}:`,
          error.message,
        );
        sensorStates[position] = {
          available: false,
          temperature: null,
          humidity: null,
        };
      },
    );
  });

  // Listen to thermal data in real-time
  const thermalRef = doc(db, "thermalRooms", "room1");
  onSnapshot(
    thermalRef,
    (snap) => {
      if (snap.exists()) {
        const data = snap.data();
        if (Array.isArray(data.frame) && data.frame.length === 768) {
          const processedFrame = data.frame
            .filter((v) => typeof v === "number" && !isNaN(v))
            .map((v) => v / 100);

          if (processedFrame.length > 0) {
            const min = Math.min(...processedFrame);
            const max = Math.max(...processedFrame);

            thermalData = {
              frame: processedFrame,
              width: data.width,
              height: data.height,
              min,
              max,
            };
          }
        }
      }

      updateFromSensorData();
    },
    (error) => {
      console.warn("Error listening to thermal data:", error.message);
    },
  );

  window.addEventListener("online", () => {
    console.log("Connection restored");
    connectionQuality = "good";
    consecutiveFailures = 0;
  });

  window.addEventListener("offline", () => {
    console.warn("Connection lost - entering offline mode");
    connectionQuality = "poor";
  });
}

function listenToSideSensorsData() {
  // Side sensors now update in real-time through listenToData()
  // This function is kept for backward compatibility but the actual
  // side sensor updates are now triggered by onSnapshot listeners
  const sensorDocIds = {
    front: "room1_front",
    back: "room1_back",
    left: "room1_left",
    right: "room1_right",
  };

  Object.entries(sensorDocIds).forEach(([position, docId]) => {
    const docRef = doc(db, "sensorData", docId);
    onSnapshot(
      docRef,
      (snap) => {
        if (!snap.exists()) return;

        const data = snap.data();
        const roomData = {
          nodeStatus: {
            [position]: {
              available: true,
              temperature: Number(data.Temperature),
              humidity: Number(data.Humidity),
              temp: Number(data.Temperature),
              rh: Number(data.Humidity),
            },
          },
        };

        if (position === "front") {
          updateFrontSensorFromRoomData(roomData);
        } else if (position === "left") {
          updateLeftSensorFromRoomData(roomData);
        } else if (position === "back") {
          updateBackSensorFromRoomData(roomData);
        } else if (position === "right") {
          updateRightSensorFromRoomData(roomData);
        }
      },
      (error) => {
        console.warn(
          `Error listening to side sensor ${position}:`,
          error.message,
        );
      },
    );
  });
}

/* =====================================================================
 * Philippine Date & Time Display
 * ===================================================================== */

async function updatePhilippineDateTime() {
  try {
    const response = await fetch(
      "https://worldtimeapi.org/api/timezone/Asia/Manila",
    );

    if (!response.ok) {
      throw new Error("WorldTimeAPI request failed");
    }

    const data = await response.json();
    const dateTime = new Date(data.datetime);

    const timeString = dateTime.toLocaleTimeString("en-PH", {
      hour: "2-digit",
      minute: "2-digit",
      hour12: true,
    });

    const dateString = dateTime.toLocaleDateString("en-PH", {
      weekday: "long",
      year: "numeric",
      month: "long",
      day: "numeric",
    });

    const timeEl = document.getElementById("ph-time");
    const dateEl = document.getElementById("ph-date");

    if (timeEl) timeEl.textContent = timeString;
    if (dateEl) dateEl.textContent = dateString;
  } catch (error) {
    if (!worldTimeApiFailed) {
      console.warn(
        "WorldTimeAPI unavailable. Falling back to local browser time.",
        error,
      );
      worldTimeApiFailed = true;
    }

    const now = new Date();

    const timeEl = document.getElementById("ph-time");
    const dateEl = document.getElementById("ph-date");

    if (timeEl) {
      timeEl.textContent = now.toLocaleTimeString("en-PH", {
        hour: "2-digit",
        minute: "2-digit",
        hour12: true,
      });
    }

    if (dateEl) {
      dateEl.textContent = now.toLocaleDateString("en-PH", {
        weekday: "long",
        year: "numeric",
        month: "long",
        day: "numeric",
      });
    }
  }
}

/* =====================================================================
 * Export Historical Logs
 * ===================================================================== */

async function exportHistoricalLogs() {
  const exportLogsButton = document.getElementById("export-logs-button");
  const originalLabel = exportLogsButton
    ? exportLogsButton.textContent
    : "Download";

  try {
    if (exportLogsButton) {
      exportLogsButton.disabled = true;
      exportLogsButton.textContent = "Downloading...";
    }

    const url = `${BACKEND_URL}/api/export/historical-logs/excel`;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 35000); // 35 second timeout

    const res = await fetch(url, { signal: controller.signal });
    clearTimeout(timeout);

    if (!res.ok) {
      // Try to parse error details from response
      let errorMessage = `Export failed (${res.status})`;
      try {
        const errorData = await res.json();
        errorMessage = errorData.error || errorMessage;
        if (errorData.details) {
          errorMessage += `: ${errorData.details}`;
        }
      } catch (e) {
        // If response is not JSON, use status text
        errorMessage = `Export failed (${res.status} ${res.statusText})`;
      }
      throw new Error(errorMessage);
    }

    const blob = await res.blob();
    
    // Verify blob size
    if (blob.size === 0) {
      throw new Error("Export file is empty. No data available for this date range.");
    }

    const downloadUrl = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = downloadUrl;
    link.download = "historical_data_logs_7days.xlsx";
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(downloadUrl);

    showToast("Downloaded: Last 7 Days (historical_data_logs_7days.xlsx)", "success");
  } catch (err) {
    console.error("Export download error:", err);
    
    // Provide detailed error message
    let errorMessage = "Failed to download logs.";
    if (err.name === "AbortError") {
      errorMessage = "Download timed out. Please try again.";
    } else if (err.message.includes("Export failed")) {
      errorMessage = err.message;
    } else if (err.message) {
      errorMessage = `Error: ${err.message}`;
    }
    
    showToast(errorMessage, "error");
  } finally {
    if (exportLogsButton) {
      exportLogsButton.disabled = false;
      exportLogsButton.textContent = originalLabel;
    }
  }
}

window.exportHistoricalLogs = exportHistoricalLogs;

/* =====================================================================
 * BOOT ALL SYSTEMS
 * ===================================================================== */

window.onload = () => {
  updatePhilippineDateTime();
  setActiveRoomBadge("room1");

  setInterval(() => {
    const now = new Date();
    const timeEl = document.getElementById("ph-time");
    const dateEl = document.getElementById("ph-date");

    if (timeEl) {
      timeEl.textContent = now.toLocaleTimeString("en-PH", {
        hour: "2-digit",
        minute: "2-digit",
        hour12: true,
      });
    }

    if (dateEl) {
      dateEl.textContent = now.toLocaleDateString("en-PH", {
        weekday: "long",
        year: "numeric",
        month: "long",
        day: "numeric",
      });
    }
  }, 1000);

  checkPeakHeatHours();

  setupRoomClickHandlers();
  setupMenuClickHandlers();
  setupDarkModeToggle();
  setupAssistantChatToggle();

  setInterval(checkPeakHeatHours, 60000);

  threeApp = initThreeJS();
  initSparkline();
  initMetricSparklines();
  
  // Initialize dashboard with default state before listeners fire
  updateDashboard(0, 0, 0, "Waiting Data", ["Initializing system..."], "Waiting for sensor data...", null);
  
  listenToData();
  listenToSideSensorsData();
  initAIChat();

  listenToThermal(REAL_ROOM_ID);

  const exportLogsButton = document.getElementById("export-logs-button");
  if (exportLogsButton) {
    exportLogsButton.addEventListener("click", (e) => {
      e.preventDefault();
      exportHistoricalLogs();
    });
  }

  const heatmapToggle = document.getElementById("heatmap-toggle");
  if (heatmapToggle) {
    heatmapToggle.addEventListener("change", (e) => {
      isHeatmapEnabled = e.target.checked;
      console.log("Heatmap enabled:", isHeatmapEnabled);

      heatSlices.forEach((slice) => {
        slice.visible = isHeatmapEnabled;
      });
    });
  }
};
