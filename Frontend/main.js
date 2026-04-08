/* =====================================================================
 * main.js – DSS Dashboard – ESP8266 + BMP280 + Firestore
 * Three.js viewer + Firestore real-time listener
 * ===================================================================== */
console.log("MAIN.JS IS RUNNING");

import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { initializeApp } from "firebase/app";
import { getFirestore, doc, onSnapshot } from "firebase/firestore";
import { Chart, registerables } from "chart.js/auto";
import { initAIChat, updateAIContext } from "./chatAi.js";

let backendDown = false;
let connectionQuality = "good"; // good, fair, poor
let consecutiveFailures = 0;
const MAX_RETRIES = 3;
const FETCH_TIMEOUT_MS = 8000; // 8 second timeout for weak WiFi
let lastSuccessfulData = null;

Chart.register(...registerables);
const BACKEND_URL = "https://website-jbd4.onrender.com";
const REAL_ROOM_ID = "room1";

/* =====================================================================
 * UI Helpers (Toast + Download State)
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
 * AI SHARED STATE (latest sensor snapshot)
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
 * 1. Firebase configuration
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
 * THERMAL FIRESTORE LISTENER Heat Mapping Logic
 * ===================================================================== */

const thermalDataByRoom = {};
const THERMAL_TIMEOUT_MS = 30000;
let thermalRecoveredOnce = {};

function initThermalRecoveryState(roomId) {
  if (!(roomId in thermalRecoveredOnce)) {
    thermalRecoveredOnce[roomId] = false;
  }
}

/**
 * Initialize thermal room state on startup
 */
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
  
  // Fetch last thermal data from Firestore
  try {
    const ref = doc(db, "thermalRooms", roomId);
    const snap = await (async () => {
      // Wrap with timeout
      const timeoutPromise = new Promise((_, reject) =>
        setTimeout(() => reject(new Error("Thermal fetch timeout")), 5000)
      );
      const docPromise = (async () => {
        const s = await new Promise((resolve, reject) => {
          const unsubscribe = onSnapshot(
            ref,
            (snapshot) => {
              unsubscribe();
              resolve(snapshot);
            },
            reject
          );
        });
        return s;
      })();
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
  
  // Initialize with last data first
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
 * 2. DSS BACKEND CONNECTOR
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
 * ROOM SELECTION LOGIC
 * ===================================================================== */

let activeRoom = REAL_ROOM_ID;
let isHeatmapEnabled = true;
let activeView = "dashboard";
let lastDashboardState = null; // Cache last dashboard data
let heatSlices = []; // Global reference for toggle control

function setActiveView(viewName) {
  const dashboardView = document.getElementById("dashboard-view");
  const settingsView = document.getElementById("settings-view");
  const aboutView = document.getElementById("about-view");
  const menuLinks = document.querySelectorAll(".menu-link");

  if (!dashboardView || !settingsView || !aboutView) return;

  activeView = viewName;
  const showSettings = viewName === "settings";
  const showAbout = viewName === "about";

  dashboardView.classList.toggle("view-hidden", showSettings || showAbout);
  settingsView.classList.toggle("view-hidden", !showSettings);
  aboutView.classList.toggle("view-hidden", !showAbout);

  menuLinks.forEach((link) => {
    const isActive = link.dataset.view === viewName;
    link.classList.toggle("active", isActive);
  });
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

function showReservedRoom2View() {
  document.getElementById("temp-val").textContent = "--";
  document.getElementById("hum-val").textContent = "--";
  document.getElementById("hi-val").textContent = "--";

  setAlertBannerVisible(false);
  setConditionBannerPlaceholder(
    "Reserved",
    "",
  );

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
  const sourceRight = document.getElementById("dss-source-right");
  if (sourceLeft) {
    sourceLeft.textContent = "";
  }
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
      console.log("Active room changed to:", activeRoom);

      if (activeRoom === "room2") {
        showReservedRoom2View();
        return;
      }

      // If we have cached data for Room 1, display it immediately
      if (lastDashboardState && activeRoom === REAL_ROOM_ID) {
        updateDashboard(
          lastDashboardState.temp,
          lastDashboardState.humidity,
          lastDashboardState.hi,
          lastDashboardState.label,
          lastDashboardState.advisory,
          lastDashboardState.monitoringStatus
        );
      } else {
        // Otherwise show loading message
        document.getElementById("dss-content").innerHTML =
          `<p>Loading live data for <b>${activeRoom.toUpperCase()}</b>...</p>`;

        const sourceLeft = document.getElementById("dss-source-left");
        const sourceRight = document.getElementById("dss-source-right");
        if (sourceLeft) {
          sourceLeft.textContent = "Based on CDRRMO Heat Index Threshold Guidelines";
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
 * 3. Three.js viewer
 * ===================================================================== */

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
  camera.position.set(0, 1, 3);

  const renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setSize(container.clientWidth, container.clientHeight);
  container.appendChild(renderer.domElement);

  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;

  const ROOM_WIDTH = 7.81;
  const ROOM_DEPTH = 6.92;
  const WALL_HEIGHT = 2.6;
  const FRONT_WALL_Z = -ROOM_DEPTH / 2;
  const DETACH_OFFSET = 0.05;

  let heatmapTexture = null;
  const heatmapCanvas = document.createElement("canvas");
  heatmapCanvas.width = 32;
  heatmapCanvas.height = 24;
  const heatmapCtx = heatmapCanvas.getContext("2d");

  // FLIR-style HSL color mapping: blue (240°) -> red (0°)
  function colorMapFLIR(value, minValue, maxValue) {
    let t = (value - minValue) / (maxValue - minValue);
    if (!isFinite(t)) t = 0;
    t = Math.max(0, Math.min(1, t));

    // Emphasize hotter regions with power gamma
    t = Math.pow(t, 1.8);

    // Hue: 240 (blue) -> 0 (red)
    const hue = (1 - t) * 240;
    
    // Brightness increases with temperature
    const light = 35 + t * 30;
    
    return { hue, light };
  }

  // Convert HSL to RGB
  function hslToRgb(h, l, s = 1.0) {
    function hue2rgb(p, q, t) {
      if (t < 0) t += 1;
      if (t > 1) t -= 1;
      if (t < 1/6) return p + (q - p) * 6 * t;
      if (t < 1/2) return q;
      if (t < 2/3) return p + (q - p) * (2/3 - t) * 6;
      return p;
    }

    h = h / 360;
    let r, g, b;

    if (s === 0) {
      r = g = b = l;
    } else {
      const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
      const p = 2 * l - q;
      r = hue2rgb(p, q, h + 1/3);
      g = hue2rgb(p, q, h);
      b = hue2rgb(p, q, h - 1/3);
    }

    return {
      r: Math.round(r * 255),
      g: Math.round(g * 255),
      b: Math.round(b * 255)
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

    // Create ImageData for direct pixel manipulation
    const imageData = heatmapCtx.createImageData(32, 24);
    const data = imageData.data;

    for (let y = 0; y < 24; y++) {
      for (let x = 0; x < 32; x++) {
        // Flip both axes for proper orientation (matching ESP32 code)
        const srcX = 31 - x;
        const srcY = 23 - y;
        const sensorIndex = srcY * 32 + srcX;

        const temp = frame[sensorIndex];
        const { hue, light } = colorMapFLIR(temp, minT, maxT);
        const { r, g, b } = hslToRgb(hue, light / 100, 1.0);

        const pixelIndex = (y * 32 + x) * 4;
        data[pixelIndex + 0] = r;
        data[pixelIndex + 1] = g;
        data[pixelIndex + 2] = b;
        data[pixelIndex + 3] = 255;
      }
    }

    heatmapCtx.putImageData(imageData, 0, 0);
    heatmapCtx.imageSmoothingEnabled = true;
    heatmapTexture.needsUpdate = true;

    const now = Date.now();

    heatSlices.forEach((slice, index) => {
      const delay = index * HEAT_TIME_LAG_MS;
      if (now - slice.userData.lastUpdateTime < delay) return;

      const decayFactor = Math.exp(-HEAT_DECAY_PER_SLICE * index);
      slice.material.opacity = HEAT_MAX_OPACITY * decayFactor;
      slice.material.emissiveIntensity = 0.6 * (decayFactor * decayFactor);

      if (!slice.material.map) {
        slice.material.map = heatmapTexture;
        slice.material.emissiveMap = heatmapTexture;
      }

      slice.userData.lastUpdateTime = now;
    });
  }

  const ambient = new THREE.AmbientLight(0xffffff, 1);
  scene.add(ambient);

  const dir = new THREE.DirectionalLight(0xffffff, 2);
  dir.position.set(5, 5, 5);
  scene.add(dir);

  heatmapTexture = new THREE.CanvasTexture(heatmapCanvas);
  // Use linear filtering for smooth FLIR-style interpolation instead of blocky pixels
  heatmapTexture.minFilter = THREE.LinearFilter;
  heatmapTexture.magFilter = THREE.LinearFilter;

  const heatmapGeometry = new THREE.PlaneGeometry(
    ROOM_WIDTH * 0.9,
    WALL_HEIGHT * 0.9,
  );

  const HEAT_SLICE_COUNT = 12;
  const HEAT_SLICE_DEPTH = ROOM_DEPTH / HEAT_SLICE_COUNT;
  const HEAT_DECAY_PER_SLICE = 0.12;
  const HEAT_TIME_LAG_MS = 120;
  const HEAT_MAX_OPACITY = 0.85;

  // Clear and reuse global heatSlices array
  heatSlices.length = 0;

  for (let i = 0; i < HEAT_SLICE_COUNT; i++) {
    const material = new THREE.MeshStandardMaterial({
      map: heatmapTexture,
      transparent: true,
      opacity: 0.0,
      side: THREE.DoubleSide,
      emissive: 0xffffff,
      emissiveMap: heatmapTexture,
      emissiveIntensity: 0.0,
    });

    const slice = new THREE.Mesh(heatmapGeometry, material);

    slice.position.set(
      0,
      0.1,
      FRONT_WALL_Z + DETACH_OFFSET + i * HEAT_SLICE_DEPTH,
    );

    slice.renderOrder = i;
    slice.userData = {
      lastUpdateTime: 0,
      intensity: 0,
    };

    heatSlices.push(slice);
    scene.add(slice);
  }

  /**
   * Optimized GLB loader with timeout, retry, and caching for weak WiFi
   */
  async function loadGLBModel() {
    const GLB_URL =
      "https://firebasestorage.googleapis.com/v0/b/dss-database-51609.firebasestorage.app/o/classroom.glb?alt=media&token=caa4c4ed-3241-4a78-95c5-b1ea4947832a";
    const GLB_CACHE_KEY = "glb_model_cache";
    const GLB_CACHE_VERSION = 1;
    const LOAD_TIMEOUT_MS = 120000; // 2 minutes for weak WiFi

    /**
     * Try to load from localStorage cache
     */
    function getCachedModel() {
      try {
        const cached = localStorage.getItem(GLB_CACHE_KEY);
        if (cached) {
          const { version, data, timestamp } = JSON.parse(cached);
          const cacheAge = Date.now() - timestamp;
          if (
            version === GLB_CACHE_VERSION &&
            cacheAge < 30 * 24 * 60 * 60 * 1000
          ) {
            // Cache valid for 30 days
            console.log("Loading GLB from cache");
            return data;
          }
        }
      } catch (err) {
        console.warn("Could not read GLB cache:", err);
      }
      return null;
    }

    /**
     * Save model to cache
     */
    function cacheModel(arrayBuffer) {
      try {
        const data = btoa(String.fromCharCode(...new Uint8Array(arrayBuffer)));
        localStorage.setItem(
          GLB_CACHE_KEY,
          JSON.stringify({
            version: GLB_CACHE_VERSION,
            data,
            timestamp: Date.now(),
          })
        );
        console.log("GLB model cached");
      } catch (err) {
        console.warn("Could not cache GLB model:", err);
      }
    }

    /**
     * Fetch GLB with timeout and progress tracking - keeps retrying indefinitely on weak WiFi
     */
    async function fetchGLBWithTimeout(url, retryCount = 0) {
      return new Promise((resolve, reject) => {
        const xhr = new XMLHttpRequest();

        xhr.open("GET", url, true);
        xhr.responseType = "arraybuffer";
        xhr.timeout = LOAD_TIMEOUT_MS;

        xhr.onprogress = (event) => {
          if (event.lengthComputable) {
            const percentComplete = Math.round(
              (event.loaded / event.total) * 100
            );
            if (loadingOverlay) {
              loadingOverlay.textContent = `Loading 3D Model... ${percentComplete}%`;
            }
            console.log(`GLB download: ${percentComplete}%`);
          }
        };

        xhr.onload = () => {
          if (xhr.status >= 200 && xhr.status < 300) {
            resolve(xhr.response);
          } else {
            reject(new Error(`HTTP ${xhr.status}`));
          }
        };

        xhr.onerror = () => {
          reject(new Error("Network error"));
        };

        xhr.ontimeout = () => {
          reject(new Error("Download timeout"));
        };

        xhr.send();
      })
        .then((arrayBuffer) => {
          return arrayBuffer;
        })
        .catch(async (error) => {
          // Keep retrying indefinitely for weak WiFi
          console.warn(
            `GLB fetch attempt ${retryCount + 1} failed:`,
            error.message
          );
          if (loadingOverlay) {
            loadingOverlay.textContent = `Retrying... (weak WiFi detected)`;
          }
          
          // Exponential backoff: 2s, 4s, 8s, 16s, 30s (max)
          const backoffMs = Math.min(Math.pow(2, retryCount) * 2000, 30000);
          console.log(
            `Retrying GLB in ${backoffMs}ms (attempt ${retryCount + 1})...`
          );
          
          await new Promise((resolve) => setTimeout(resolve, backoffMs));
          return fetchGLBWithTimeout(url, retryCount + 1);
        });
    }

    /**
     * Parse GLB from ArrayBuffer
     */
    function parseGLB(arrayBuffer) {
      return new Promise((resolve, reject) => {
        const loader = new GLTFLoader();
        loader.parse(
          arrayBuffer,
          "",
          (gltf) => {
            resolve(gltf);
          },
          reject
        );
      });
    }

    const loadingOverlay = document.getElementById("loading-overlay");

    /**
     * Show placeholder geometry while loading on weak WiFi
     */
    function createPlaceholder() {
      const group = new THREE.Group();

      // Simple box representing the room
      const boxGeometry = new THREE.BoxGeometry(7, 2.6, 6.5);
      const boxMaterial = new THREE.MeshStandardMaterial({
        color: 0x888888,
        wireframe: false,
        roughness: 0.6,
        metalness: 0.1,
      });
      const boxMesh = new THREE.Mesh(boxGeometry, boxMaterial);
      boxMesh.position.set(0, 0.3, 0);
      group.add(boxMesh);

      // Edges to make it more visible
      const edges = new THREE.EdgesGeometry(boxGeometry);
      const lineSegments = new THREE.LineSegments(
        edges,
        new THREE.LineBasicMaterial({ color: 0x333333, linewidth: 2 })
      );
      lineSegments.position.set(0, 0.3, 0);
      group.add(lineSegments);

      return group;
    }

    // Show placeholder immediately on weak WiFi
    const placeholder = createPlaceholder();
    scene.add(placeholder);
    console.log("Placeholder geometry added");

    try {
      // Try cache first
      let glbData = getCachedModel();
      let isFromCache = true;

      if (!glbData) {
        isFromCache = false;
        // Fetch from network
        if (loadingOverlay) {
          loadingOverlay.textContent = "Loading 3D Model...";
        }
        console.log("Fetching GLB from network");
        glbData = await fetchGLBWithTimeout(GLB_URL);
        cacheModel(glbData);
      }

      // Parse GLB
      if (loadingOverlay && !isFromCache) {
        loadingOverlay.textContent = "Parsing 3D Model... 99%";
      }
      const binaryString = atob(
        typeof glbData === "string" ? glbData : btoa(String.fromCharCode(...new Uint8Array(glbData)))
      );
      const bytes = new Uint8Array(binaryString.length);
      for (let i = 0; i < binaryString.length; i++) {
        bytes[i] = binaryString.charCodeAt(i);
      }

      const gltf = await parseGLB(bytes.buffer);

      if (loadingOverlay) {
        loadingOverlay.style.display = "none";
      }

      // Remove placeholder and add real model
      scene.remove(placeholder);
      console.log("Placeholder removed, adding real model");

      const model = gltf.scene;
      const box = new THREE.Box3().setFromObject(model);
      const center = box.getCenter(new THREE.Vector3());
      model.position.sub(center);
      scene.add(model);

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
    camera.aspect = container.clientWidth / container.clientHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(container.clientWidth, container.clientHeight);
  });

  function animate() {
    requestAnimationFrame(animate);
    controls.update();
    renderer.render(scene, camera);
  }

  setInterval(() => {
    const roomState = thermalDataByRoom[REAL_ROOM_ID];
    const now = Date.now();

    if (activeRoom !== REAL_ROOM_ID) {
      heatSlices.forEach((slice) => {
        slice.visible = false;
      });
      return;
    }

    if (!roomState) {
      heatSlices.forEach((slice) => {
        slice.visible = isHeatmapEnabled;
      });
      return;
    }

    if (
      roomState.ready &&
      now - roomState.lastUpdateTime > THERMAL_TIMEOUT_MS
    ) {
      if (!roomState.stale) {
        roomState.stale = true;
        console.warn(`Thermal watchdog: ${REAL_ROOM_ID} data stream stale`);

        heatSlices.forEach((slice) => {
          slice.material.opacity *= 0.3;
          slice.material.emissiveIntensity = 0.01;
        });
      }
    }

    heatSlices.forEach((slice) => {
      slice.visible = isHeatmapEnabled;
    });

    if (
      isHeatmapEnabled &&
      !roomState.stale &&
      roomState.dirty &&
      roomState.frame
    ) {
      updateHeatFromFrontSensor(roomState.frame);
      roomState.dirty = false;
    }

    if (roomState.restoreVisual) {
      console.info(`Restoring volumetric visuals for ${REAL_ROOM_ID}`);
      roomState.dirty = true;
      roomState.restoreVisual = false;
    }
  }, 30000);

  animate();
}

/* =====================================================================
 * 4. Notification Banner for Extreme Heat Index
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
 * 5. Notification Banner for Peak Heat Hours
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
 * 6. Dashboard updating
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

  // Cache the dashboard state for quick display when switching rooms
  lastDashboardState = {
    temp,
    humidity,
    hi,
    label,
    advisory,
    monitoringStatus,
  };

  document.getElementById("temp-val").textContent = temp.toFixed(1);
  document.getElementById("hum-val").textContent = humidity.toFixed(1);
  document.getElementById("hi-val").textContent = hi.toFixed(1);

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

  document.getElementById("dss-title").innerHTML =
    `Heat Index Advisory (Decision Support System): <span style="color:${color}; font-size:1.5em; font-weight:bold;">${label}</span>`;

  const dssBox = document.getElementById("dss-content");
  dssBox.replaceChildren(
    ...advisory.map((line) => {
      const p = document.createElement("p");
      p.textContent = String(line);
      return p;
    }),
  );

  const dssSourceLeft = document.getElementById("dss-source-left");
  const dssSourceRight = document.getElementById("dss-source-right");
  if (dssSourceLeft) {
    dssSourceLeft.textContent = "Based on CDRRMO Heat Index Threshold Guidelines";
  }
  if (dssSourceRight) {
    dssSourceRight.textContent = monitoringStatus;
  }
}

/* =====================================================================
 * 7. Line Chart Setup
 * ===================================================================== */

let sensorChart = null;
let chartData = {
  labels: [],
  temp: [],
  hum: [],
  hi: [],
};



function initSparkline() {
  const ctx = document.getElementById("sensorChart").getContext("2d");
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
          tension: 0.4,
          fill: false,
          pointRadius: 5,
        },
        {
          label: "Humidity (%)",
          data: chartData.hum,
          borderColor: "rgba(0,0,255,0.8)",
          backgroundColor: "rgba(0,0,255,0.2)",
          tension: 0.4,
          fill: false,
          pointRadius: 5,
        },
        {
          label: "Heat Index (°C)",
          data: chartData.hi,
          borderColor: "rgba(255,165,0,0.8)",
          backgroundColor: "rgba(255,165,0,0.2)",
          tension: 0.4,
          fill: false,
          pointRadius: 5,
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: {
        mode: 'index',
        intersect: false,
      },
      plugins: {
        legend: {
          display: true,
          position: "top",
        },
        tooltip: {
          enabled: true,
          backgroundColor: 'rgba(0,0,0,0.8)',
          titleColor: '#fff',
          bodyColor: '#fff',
          borderColor: '#fff',
          borderWidth: 1,
          cornerRadius: 8,
          displayColors: true,
          callbacks: {
            title: function(context) {
              return `Time: ${context[0].label}`;
            },
            label: function(context) {
              return `${context.dataset.label}: ${context.parsed.y}`;
            }
          }
        },
      },
      scales: {
        x: { display: true },
        y: { beginAtZero: true },
      },
      animation: {
        duration: 1000,
        easing: 'easeInOutQuart',
      },
    },
  });
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
}

/* =====================================================================
 * 8. Backend listener with WiFi resilience
 * ===================================================================== */

/**
 * Fetch with timeout and retry logic for weak WiFi
 */
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

/**
 * Save last successful data to localStorage for offline use
 */
function cacheSuccessfulData(data) {
  try {
    localStorage.setItem(
      "lastRoomData",
      JSON.stringify({
        data,
        timestamp: Date.now(),
      })
    );
    lastSuccessfulData = data;
  } catch (err) {
    console.warn("Could not cache data to localStorage:", err);
  }
}

/**
 * Retrieve cached data from localStorage
 */
function getCachedData() {
  try {
    const cached = localStorage.getItem("lastRoomData");
    if (cached) {
      const parsed = JSON.parse(cached);
      const cacheAge = Date.now() - parsed.timestamp;
      const MAX_CACHE_AGE = 5 * 60 * 1000; // 5 minutes

      if (cacheAge < MAX_CACHE_AGE) {
        return parsed.data;
      }
    }
  } catch (err) {
    console.warn("Could not retrieve cached data:", err);
  }
  return lastSuccessfulData;
}

/**
 * Attempt to fetch data with retry logic
 */
async function fetchDataWithRetry(roomId, retryCount = 0) {
  try {
    const res = await fetchWithTimeout(
      `${BACKEND_URL}/api/${roomId}`,
      FETCH_TIMEOUT_MS
    );

    if (!res.ok) {
      throw new Error(`HTTP ${res.status}`);
    }

    const json = await res.json();
    const roomData = json[roomId];
    if (!roomData) throw new Error("Invalid room data");

    // Validate data
    const temp = Number(roomData.averageTemperature);
    const hum = Number(roomData.averageHumidity);
    const hi = Number(roomData.heatIndex);

    if (isNaN(temp) || isNaN(hum) || isNaN(hi)) {
      throw new Error("Invalid numeric values");
    }

    // Success - reset failure counter
    consecutiveFailures = 0;
    connectionQuality = "good";
    cacheSuccessfulData(roomData);
    return roomData;
  } catch (error) {
    console.warn(
      `Fetch attempt ${retryCount + 1}/${MAX_RETRIES} failed:`,
      error.message
    );

    // Retry with exponential backoff
    if (retryCount < MAX_RETRIES) {
      const backoffMs = Math.pow(2, retryCount) * 1000; // 1s, 2s, 4s
      await new Promise((resolve) => setTimeout(resolve, backoffMs));
      return fetchDataWithRetry(roomId, retryCount + 1);
    }

    throw error;
  }
}

async function listenToData() {
  let pollingIntervalId;

  const poll = async () => {
    if (activeRoom !== REAL_ROOM_ID) {
      return;
    }

    try {
      const roomData = await fetchDataWithRetry(REAL_ROOM_ID);

      if (!roomData) throw new Error("No room data");

      const temp = Number(roomData.averageTemperature);
      const hum = Number(roomData.averageHumidity);
      const hi = Number(roomData.heatIndex);

      backendDown = false;

      const monitoringStatus =
        roomData.monitoringStatus || "Based on 4 sensor positions";

      updateDashboard(temp, hum, hi, roomData.label, roomData.advisory, monitoringStatus);
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
    } catch (err) {
      consecutiveFailures++;
      connectionQuality =
        consecutiveFailures > 2 ? "poor" : consecutiveFailures > 1 ? "fair" : "good";

      if (!backendDown) {
        console.warn(
          `Backend error (attempt ${consecutiveFailures}):`,
          err.message
        );
        backendDown = true;
      }

      // Try to use cached data
      let cachedData = getCachedData();

      let temp, hum, fallbackHI, label, advisory;

      if (cachedData) {
        // Use cached data
        temp = cachedData.averageTemperature;
        hum = cachedData.averageHumidity;
        fallbackHI = cachedData.heatIndex;
        label = `${cachedData.label} (CACHED)`;
        advisory = [
          ...cachedData.advisory,
          "Using cached data due to connection issues.",
        ];
      } else {
        // Fall back to latest context or defaults
        temp = latestAIContext.temperature || 30;
        hum = latestAIContext.humidity || 60;
        fallbackHI = computeFallbackHeatIndex(temp, hum);
        label = "ESTIMATED (FALLBACK)";
        advisory = [
          "Backend Decision Support System unavailable.",
          "Using local heat index estimation.",
          "Check your WiFi connection.",
        ];
      }

      updateDashboard(
        temp,
        hum,
        fallbackHI,
        label,
        advisory,
        `Fallback mode (${connectionQuality} connection)`
      );

      updateSparkline(temp, hum, fallbackHI);

      updateAIContext({
        room: REAL_ROOM_ID,
        temperature: temp,
        humidity: hum,
        heatIndex: fallbackHI,
        label,
        advisory,
        backendDown: true,
        sensorsDown: false,
      });
    }
  };

  // Initial poll
  await poll();

  // Adaptive polling interval based on connection quality
  const startPolling = () => {
    if (pollingIntervalId) clearInterval(pollingIntervalId);

    let interval = 60000; // Default: 60 seconds

    if (connectionQuality === "fair") {
      interval = 90000; // Weak connection: 90 seconds
    } else if (connectionQuality === "poor") {
      interval = 120000; // Poor connection: 120 seconds
    }

    pollingIntervalId = setInterval(poll, interval);
  };

  startPolling();

  // Monitor online/offline status
  window.addEventListener("online", () => {
    console.log("Connection restored");
    connectionQuality = "good";
    consecutiveFailures = 0;
    startPolling();
    poll();
  });

  window.addEventListener("offline", () => {
    console.warn("Connection lost - entering offline mode");
    connectionQuality = "poor";
  });
}

/* =====================================================================
 * 9. Philippine Date & Time Display
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
 * 10. Export Historical Logs
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
    const res = await fetch(url);

    if (!res.ok) {
      throw new Error(`Export failed (${res.status})`);
    }

    const blob = await res.blob();
    const downloadUrl = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = downloadUrl;
    link.download = "historical_data_logs.xlsx";
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(downloadUrl);

    showToast("Download started.", "success");
  } catch (err) {
    console.error("Export download error:", err);
    showToast("Failed to download logs. Please try again.", "error");
  } finally {
    if (exportLogsButton) {
      exportLogsButton.disabled = false;
      exportLogsButton.textContent = originalLabel;
    }
  }
}

window.exportHistoricalLogs = exportHistoricalLogs;

/* =====================================================================
 * 11. BOOT ALL SYSTEMS
 * ===================================================================== */

window.onload = () => {
  updatePhilippineDateTime();

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

  setInterval(checkPeakHeatHours, 60000);

  initThreeJS();
  initSparkline();
  listenToData();
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
      
      // Immediately update heatmap visibility
      heatSlices.forEach((slice) => {
        slice.visible = isHeatmapEnabled;
      });
    });
  }
};
