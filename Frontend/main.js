/* =====================================================================
 * main.js – DSS Dashboard – ESP8266 + BMP280 + Firestore
 * Three.js viewer + Firestore real-time listener
 * ===================================================================== */
console.log('MAIN.JS IS RUNNING');

import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { initializeApp } from 'firebase/app';
import {getFirestore, doc, onSnapshot} from 'firebase/firestore';
import { Chart, registerables } from 'chart.js/auto';
import { initAIChat, updateAIContext } from './chatAi.js';
let backendDown = false;



Chart.register(...registerables);

/* =====================================================================
 * AI SHARED STATE (latest sensor snapshot) 
 * ===================================================================== */

let latestAIContext = {
  room: null,
  temperature: null,
  humidity: null,
  heatIndex: null,
  label: null,
  advisory: null
};

let worldTimeApiFailed = false; // Flag for WorldTimeAPI failure

/* =====================================================================
 * 1. Firebase configuration
 * ===================================================================== */

const firebaseConfig = {
  apiKey: 'AIzaSyCq6MUL63iHYpOrGqoQrWCjDPWhOnNajmQ',
  authDomain: 'dss-database-51609.firebaseapp.com',
  projectId: 'dss-database-51609',
  storageBucket: 'dss-database-51609.firebasestorage.app',
  messagingSenderId: '514112370816',
  appId: '1:514112370816:web:46c160c80475164b98ce65',
  measurementId: 'G-707NP59NVW'
};

const app = initializeApp(firebaseConfig);
const db = getFirestore(app);

/* =====================================================================
 * THERMAL FIRESTORE LISTENER Heat Mapping Logic
 * ===================================================================== */

const thermalDataByRoom = {}; // Each room will have: { frame, ready, dirty, lastUpdateTime, stale }
const THERMAL_TIMEOUT_MS = 6000; // 6 seconds tolerance
let thermalRecoveredOnce = {}; // per-room recovery tracking

function initThermalRecoveryState(roomId) {
  if (!(roomId in thermalRecoveredOnce)) {
    thermalRecoveredOnce[roomId] = false;
  }
}

function listenToThermal(roomId = 'room1') {
  initThermalRecoveryState(roomId);
  const ref = doc(db, 'thermalRooms', roomId);

  onSnapshot(ref, (snap) => {
    if (!snap.exists()) return;

    const data = snap.data();

    // Safety checks
    if (!Array.isArray(data.frame) || data.frame.length !== 768) {
      console.warn(`Invalid thermal frame for ${roomId}`);
      return;
    }

    // Initialize room state if missing
    if (!thermalDataByRoom[roomId]) {
      thermalDataByRoom[roomId] = {
        frame: null,
        ready: false,
        dirty: false,
        lastUpdateTime: 0,
        stale: false
      };
    }

    const roomState = thermalDataByRoom[roomId];
    const wasStale = roomState.stale;
    roomState.frame = data.frame;
    roomState.dirty = true;
    roomState.lastUpdateTime = Date.now();
    roomState.stale = false;

    // ===== THERMAL RECOVERY DETECTION =====
    if (wasStale && !thermalRecoveredOnce[roomId]) {
      console.info(`Thermal stream recovered for ${roomId}`);
      thermalRecoveredOnce[roomId] = true;
      // Mark for visual restoration
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

// Simple fallback Heat Index function
function computeFallbackHeatIndex(tempC, humidity) {
  let HI = tempC;

  if (tempC >= 27) {
    HI = tempC + (0.05 * humidity);
  }

  // Never exaggerate perceived heat
  if (HI < tempC) HI = tempC;
  if (HI > tempC + 3) HI = tempC + 3;

  return Number(HI.toFixed(1));
}

/* =====================================================================
 * ROOM SELECTION LOGIC
 * ===================================================================== */

let activeRoom = 'room1'; // default room
let isHeatmapEnabled = true;

function setupRoomClickHandlers() {
  const roomLinks = document.querySelectorAll('.room-link');

  roomLinks.forEach(link => {
    link.addEventListener('click', e => {
      e.preventDefault();
      roomLinks.forEach(l => l.classList.remove('active'));
      link.classList.add('active');
      activeRoom = link.dataset.room;
      console.log('Active room changed to:', activeRoom);

      document.getElementById('dss-content').innerHTML =
        `<p>Currently viewing data for <b>${activeRoom.toUpperCase()}</b></p>`;

      // Start listening to thermal data for this room if not already
      if (!thermalDataByRoom[activeRoom]) {
        listenToThermal(activeRoom);
      }
    });
  });
}

/* =====================================================================
 * 3. Three.js viewer
 * ===================================================================== */

function initThreeJS() {
  const container = document.getElementById('canvas-container');
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0xffffff);

  const camera = new THREE.PerspectiveCamera(
    75,
    container.clientWidth / container.clientHeight,
    0.1,
    1000
  );
  camera.position.set(0, 1, 3);

  const renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setSize(container.clientWidth, container.clientHeight);
  container.appendChild(renderer.domElement);

  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;

  /* ===== CLASSROOM REAL-WORLD DIMENSIONS (meters) ===== */
  const ROOM_WIDTH = 7.81; // X-axis (left ↔ right)
  const ROOM_DEPTH = 6.92; // Z-axis (front ↔ back)
  const WALL_HEIGHT = 2.60; // Y-axis (floor → top of wall)
  // Z-position of the front wall (Three.js forward is -Z by convention)
  const FRONT_WALL_Z = -ROOM_DEPTH / 2;
  const DETACH_OFFSET = 0.05; // small offset to avoid z-fighting

  /* ===== THERMAL HEATMAP PLACEHOLDER ===== */
  let heatmapMesh = null;
  let heatmapTexture = null;
  const heatmapCanvas = document.createElement('canvas');
  heatmapCanvas.width = 32;
  heatmapCanvas.height = 24;
  const heatmapCtx = heatmapCanvas.getContext('2d');

  // Paint initial black frame (prevents "dead black" texture)
  heatmapCtx.fillStyle = 'black';
  heatmapCtx.fillRect(0, 0, 32, 24);

function updateHeatFromFrontSensor(frame) {
  if (!frame || frame.length !== 768) return;

  // 1. Normalize temperatures for color mapping
  let minT = Infinity;
  let maxT = -Infinity;
  for (const t of frame) {
    if (t < minT) minT = t;
    if (t > maxT) maxT = t;
  }
  if (maxT - minT < 2) maxT = minT + 2;

  // 2. Draw raw thermal pixels to the 32x24 canvas
  for (let i = 0; i < 768; i++) {
    const val = frame[i];
    const norm = Math.max(0, Math.min(1, (val - minT) / (maxT - minT)));
    
    // Map intensity to HSL: 240 (Blue) to 0 (Red)
    const hue = (0.66 - (norm * 0.66)) * 360;
    heatmapCtx.fillStyle = `hsl(${hue}, 100%, 50%)`;
    
    const x = i % 32;
    const y = Math.floor(i / 32);
    heatmapCtx.fillRect(x, y, 1, 1);
  }

  // 3. Update the texture on the GPU
  heatmapTexture.needsUpdate = true;

  const now = Date.now();

  // 4. Propagate the texture view through the slices with refined dissipation
  heatSlices.forEach((slice, index) => {
    const delay = index * HEAT_TIME_LAG_MS;
    
    // Only update this slice if enough time has passed (creates the ripple/wave effect)
    if (now - slice.userData.lastUpdateTime < delay) return;

    // --- REFINED DEPTH DECAY MATH ---
    // Exponential decay: Intensity = Base * e^(-k * distance)
    const decayFactor = Math.exp(-HEAT_DECAY_PER_SLICE * index);
    
    // 1. Opacity: How "thick" the heat air looks. 
    // We want it to linger a bit even as it cools.
    slice.material.opacity = HEAT_MAX_OPACITY * decayFactor;

    // 2. Emissive Intensity: How much the heat "glows".
    // Heat energy (glow) usually dissipates faster than the air density.
    // We square the decay factor to make the glow drop off more sharply.
    slice.material.emissiveIntensity = 0.6 * (decayFactor * decayFactor);
    
    // 3. Ensure the texture is mapped
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

  /* ===== HEATMAP PLANE ===== */
  // Create texture from canvas
  heatmapTexture = new THREE.CanvasTexture(heatmapCanvas);
  heatmapTexture.minFilter = THREE.NearestFilter;
  heatmapTexture.magFilter = THREE.NearestFilter;

  // Material
  const heatmapMaterial = new THREE.MeshStandardMaterial({
    map: heatmapTexture,
    side: THREE.DoubleSide,
    transparent: true,
    opacity: 0.85
  });

  // Emissive to make it glow slightly
  heatmapMaterial.emissive = new THREE.Color(0xffffff);
  heatmapMaterial.emissiveIntensity = 0.05;

  // Plane geometry sized to front wall (Correctly scaled)
  const heatmapGeometry = new THREE.PlaneGeometry(
    ROOM_WIDTH * 0.9, // slightly smaller than wall width
    WALL_HEIGHT * 0.9 // slightly smaller than wall height
  );

  // Heat Propagation configuration
  const HEAT_SLICE_COUNT = 12;
  const HEAT_SLICE_DEPTH = ROOM_DEPTH / HEAT_SLICE_COUNT;

  // Controls realism
  const HEAT_DECAY_PER_SLICE = 0.12;   // how much heat fades per depth
  const HEAT_TIME_LAG_MS = 120;        // delay per slice (illusion of movement)

  // Heat slice configuration
  const HEAT_MAX_OPACITY = 0.85;

  /* ===== HEAT SLICES (each has its own material & state) ===== */
  const heatSlices = [];

  for (let i = 0; i < HEAT_SLICE_COUNT; i++) {
    // We use 'map' and 'emissiveMap' so the pixels show up and glow
    const material = new THREE.MeshStandardMaterial({
      map: heatmapTexture,
      transparent: true,
      opacity: 0.0,            // Start hidden until data arrives
      side: THREE.DoubleSide,
      emissive: 0xffffff,      // Set to white so the map colors shine through
      emissiveMap: heatmapTexture,
      emissiveIntensity: 0.0
    });

    const slice = new THREE.Mesh(heatmapGeometry, material);

    slice.position.set(
      0,
      0.1,
      FRONT_WALL_Z + DETACH_OFFSET + i * HEAT_SLICE_DEPTH
    );

    // Ensure layers render in order from back to front for correct transparency
    slice.renderOrder = i;

    slice.userData = {
      lastUpdateTime: 0,
      intensity: 0
    };

    heatSlices.push(slice);
    scene.add(slice);
  }

  // Front-most slice remains the thermal source
  heatmapMesh = heatSlices[0];

  const loader = new GLTFLoader();
  loader.load(
    'https://firebasestorage.googleapis.com/v0/b/dss-database-51609.firebasestorage.app/o/classroom.glb?alt=media&token=caa4c4ed-3241-4a78-95c5-b1ea4947832a',
    (gltf) => {
      document.getElementById('loading-overlay').style.display = 'none';
      const model = gltf.scene;
      const box = new THREE.Box3().setFromObject(model);
      const center = box.getCenter(new THREE.Vector3());
      model.position.sub(center);
      scene.add(model);
    },
    undefined,
    (error) => {
      console.error('GLB load error:', error);
      document.getElementById('loading-overlay').textContent = 'Error Loading Model';
    }
  );

  window.addEventListener('resize', () => {
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
    const now = Date.now();
    const roomState = thermalDataByRoom[activeRoom];

    if (!roomState) return; // No data yet for this room

    // 1. WATCHDOG CHECK: Detect if data stopped flowing
if (roomState.ready && now - roomState.lastUpdateTime > THERMAL_TIMEOUT_MS) {
  if (!roomState.stale) {
    roomState.stale = true;
    console.warn(`Thermal watchdog: ${activeRoom} data stream stale`);

    heatSlices.forEach(slice => {
      slice.material.opacity *= 0.3;
      slice.material.emissiveIntensity = 0.01;
    });

    // ACTIVATE DASHBOARD FALLBACK
    updateDashboard(
      0,
      0,
      0,
      'ESTIMATED (FALLBACK)',
      ['Sensor offline. Showing last known safe estimate.']
    );
  }
}


    // Heatmap visibility control
    heatSlices.forEach(slice => {
      slice.visible = isHeatmapEnabled;
    });

    // 2. DRAW ONLY IF DATA IS FRESH AND HEATMAP IS ENABLED
    if (isHeatmapEnabled && !roomState.stale && roomState.dirty && roomState.frame) {
      updateHeatFromFrontSensor(roomState.frame);
      roomState.dirty = false;
    }


    // 3. RESTORE visuals if recovery is detected
    if (roomState.restoreVisual) {
      console.info(`Restoring volumetric visuals for ${activeRoom}`);
      // On recovery, we don't need to manually set opacity; 
      // the next updateHeatFromFrontSensor call will handle it.
      roomState.dirty = true; 
      roomState.restoreVisual = false;
    }
  }, 1000);

  animate();
}

/* =====================================================================
 * 4. Notification Banner for Extreme Heat Index
 * ===================================================================== */

function showAlertBanner(message) {
  const banner = document.getElementById('alert-banner');
  const msg = document.getElementById('alert-message');
  msg.textContent = message;
  banner.classList.remove('hidden');
  banner.classList.add('show');

  // Hide automatically after 5 seconds
  setTimeout(() => {
    banner.classList.remove('show');
    banner.classList.add('hidden');
  }, 5000);
}

// Shift + N
// Manual control for testing notification banner
document.addEventListener('keydown', (e) => {
  if (e.shiftKey && e.key === 'N') {
    // Press "shift + N" to trigger alert banner
    showAlertBanner('⚠️WARNING: Heat index is greater than 41°C⚠️');
  }
});

/* =====================================================================
 * 5. Notification Banner for Peak Heat Hours
 * ===================================================================== */

function showPeakBanner() {
  const banner = document.getElementById('peak-heat-banner');
  banner.classList.remove('hidden');
  banner.classList.add('show');

  // Hide automatically after 5 seconds
  setTimeout(() => {
    banner.classList.remove('show');
    banner.classList.add('hidden');
  }, 5000);
}

// Logic to show the peak heat hours banner
function checkPeakHeatHours() {
  const now = new Date();
  const hour = now.getHours(); // 0-23

  if (hour >= 11 && hour < 16) {
    // 11 AM – 4 PM
    showPeakBanner();
    return true;
  }

  return false;
}

// Shift + P
// Manual control for testing peak heat hours banner
document.addEventListener('keydown', (e) => {
  if (e.shiftKey && e.key === 'P') {
    // Press "SHIFT + P" to trigger peak heat hours banner
    showPeakBanner();
  }
});

/* =====================================================================
 * 6. Dashboard updating
 * ===================================================================== */

// Update dashboard values
function updateDashboard(temp, humidity, hi, label, advisory) {
  // Safety defaults (backend-first, frontend-safe)
  hi = Number(hi) || 0;
  label = label || 'UNKNOWN';

  if (Array.isArray(advisory)) {
    // do nothing
  } else if (typeof advisory === 'string') {
    advisory = [advisory];
  } else {
    advisory = ['No advisory available'];
  }

  document.getElementById('temp-val').textContent = temp.toFixed(1);
  document.getElementById('hum-val').textContent = humidity.toFixed(1);
  document.getElementById('hi-val').textContent = hi.toFixed(1);

  if (hi > 41) {
    showAlertBanner('⚠️WARNING: Heat index is greater than 41°C⚠️');
  }

  // Determine color per threshold
  let color = 'black'; // default

  switch (label) {
    case 'Caution':
      color = 'green';
      break;
    case 'EXTREME CAUTION':
      color = 'yellow';
      break;
    case 'DANGER':
      color = 'orange';
      break;
    case 'EXTREME DANGER':
      color = 'red';
      break;
    case 'ESTIMATED (FALLBACK)':
      color = 'gray';
      break;
  }

  // Update DSS title with styled label
  document.getElementById('dss-title').innerHTML =
    `Heat Index Advisory (Decision Support System): <span style="color:${color}; font-size:1.5em; font-weight:bold;">${label}</span>`;

  // Use Logic for Decision Support System
  const dssBox = document.getElementById('dss-content');
  dssBox.innerHTML = advisory.map((item) => `<p>• ${item}</p>`).join('');
}

/* =====================================================================
 * 7. Bar line Charts Setup
 * ===================================================================== */

let sensorChart = null;
let chartData = {
  labels: [],
  temp: [],
  hum: [],
  hi: []
};

// Initialize the line-sparkline chart
function initSparkline() {
  const ctx = document.getElementById('sensorChart').getContext('2d');
  sensorChart = new Chart(ctx, {
    type: 'line', // Line chart for sparkline
    data: {
      labels: chartData.labels,
      datasets: [
        {
          label: 'Temperature (°C)',
          data: chartData.temp,
          borderColor: 'rgba(255,0,0,0.8)',
          backgroundColor: 'rgba(255,0,0,0.2)',
          tension: 0.4, // smooth curves
          fill: false,
          pointRadius: 5 // dot size
        },
        {
          label: 'Humidity (hPa)',
          data: chartData.hum,
          borderColor: 'rgba(0,0,255,0.8)',
          backgroundColor: 'rgba(0,0,255,0.2)',
          tension: 0.4,
          fill: false,
          pointRadius: 5
        },
        {
          label: 'Heat Index (°C)',
          data: chartData.hi,
          borderColor: 'rgba(255,165,0,0.8)',
          backgroundColor: 'rgba(255,165,0,0.2)',
          tension: 0.4,
          fill: false,
          pointRadius: 5
        }
      ]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: {
          display: true,
          position: 'top'
        }
      },
      scales: {
        x: { display: true }, // show/hide X axis
        y: { beginAtZero: true } // Y axis starts at 0
      }
    }
  });
}

// Update bar line with new data
function updateSparkline(temp, hum, hi) {
  const ts = new Date().toLocaleTimeString();
  chartData.labels.push(ts);
  chartData.temp.push(temp);
  chartData.hum.push(hum);
  chartData.hi.push(hi);

  // Keep only last 20 points
  if (chartData.labels.length > 20) {
    chartData.labels.shift();
    chartData.temp.shift();
    chartData.hum.shift();
    chartData.hi.shift();
  }

  if (sensorChart) sensorChart.update();
}


/* =====================================================================
 * 8. Firestore listener – Optimized for network fallback and per-room debounce
 * ===================================================================== */
async function listenToData() {
  setInterval(async () => {
    try {
      const BACKEND_URL = ("https://website-jbd4.onrender.com");
      const res = await fetch(`${BACKEND_URL}/api/${activeRoom}`);

      if (!res.ok) {
        throw new Error("Backend not responding");
      }

      const json = await res.json();
      const roomData = json[activeRoom];
      if (!roomData) throw new Error("Invalid room data");

      const temp = Number(roomData.averageTemperature);
      const hum  = Number(roomData.averageHumidity);
      const hi   = Number(roomData.heatIndex);

      if (isNaN(temp) || isNaN(hum) || isNaN(hi)) {
        throw new Error("Invalid numeric values");
      }

      backendDown = false;

      updateDashboard(temp, hum, hi, roomData.label, roomData.advisory);
      updateSparkline(temp, hum, hi);

      // Cache latest valid values
      latestAIContext = {
        room: activeRoom,
        temperature: temp,
        humidity: hum,
        heatIndex: hi,
        label: roomData.label,
        advisory: roomData.advisory
      };

      updateAIContext({
        temperature: temp,
        humidity: hum,
        heatIndex: hi,
        label: roomData.label,
        advisory: roomData.advisory,
        backendDown: false,
        sensorsDown: false
      }); // Update AI chat context with latest data
    
} catch (err) {
    if (!backendDown) {
    console.warn("Backend unavailable — activating dashboard fallback");
    backendDown = true;
  }

  let temp = latestAIContext.temperature;
  let hum  = latestAIContext.humidity;

  // If backend never succeeded yet,
  // create safe baseline values instead of null
  if (temp == null || hum == null) {
    temp = 30;   // safe neutral baseline
    hum  = 60;
  }

  const fallbackHI = computeFallbackHeatIndex(temp, hum);

  const fallbackAdvisory = [
    "Backend Decision Support System unavailable.",
    "Using local heat index estimation.",
    "Values are safe approximations."
  ];

  updateDashboard(
    temp,
    hum,
    fallbackHI,
    "ESTIMATED (FALLBACK)",
    fallbackAdvisory
  );

  updateSparkline(temp, hum, fallbackHI);

  // 🔥 THIS WAS MISSING
  updateAIContext({
    temperature: temp,
    humidity: hum,
    heatIndex: fallbackHI,
    label: "ESTIMATED (FALLBACK)",
    advisory: fallbackAdvisory,
    backendDown: true,
    sensorsDown: false
  });
}

  }, 1000); // Poll every second for new data (adjust as needed)
}


/* =====================================================================
 * 9. Philippine Date & Time Display
 * ===================================================================== */

async function updatePhilippineDateTime() {
  try {
    const response = await fetch('https://worldtimeapi.org/api/timezone/Asia/Manila');

    if (!response.ok) {
      throw new Error('WorldTimeAPI request failed');
    }

    const data = await response.json();
    const dateTime = new Date(data.datetime);

    // Format time
    const timeString = dateTime.toLocaleTimeString('en-PH', {
      hour: '2-digit',
      minute: '2-digit',
      hour12: true
    });

    // Format date
    const dateString = dateTime.toLocaleDateString('en-PH', {
      weekday: 'long',
      year: 'numeric',
      month: 'long',
      day: 'numeric'
    });

    document.getElementById('ph-time').textContent = timeString;
    document.getElementById('ph-date').textContent = dateString;
  } catch (error) {
    if (!worldTimeApiFailed) {
      console.warn('WorldTimeAPI unavailable. Falling back to local browser time.', error);
      worldTimeApiFailed = true; // Set flag to avoid repeated warnings
    }

    // Fallback: Browser time
    const now = new Date();
    document.getElementById('ph-time').textContent = now.toLocaleTimeString('en-PH', {
      hour: '2-digit',
      minute: '2-digit',
      hour12: true
    });
    document.getElementById('ph-date').textContent = now.toLocaleDateString('en-PH', {
      weekday: 'long',
      year: 'numeric',
      month: 'long',
      day: 'numeric'
    });
  }
}

/* =====================================================================
 * 10. BOOT ALL SYSTEMS
 * ===================================================================== */

window.onload = () => {
  // Initialize Philippine Date & Time display
  updatePhilippineDateTime();

  // Then only update browser clock locally every second
  setInterval(() => {
    const now = new Date();

    document.getElementById('ph-time').textContent =
      now.toLocaleTimeString('en-PH', {
        hour: '2-digit',
        minute: '2-digit',
        hour12: true
      });

    document.getElementById('ph-date').textContent =
      now.toLocaleDateString('en-PH', {
        weekday: 'long',
        year: 'numeric',
        month: 'long',
        day: 'numeric'
      });

  }, 1000); // Update every second

  // Check for Peak Heat Hours on load
  checkPeakHeatHours();

  // Setup Room Click Handlers
  setupRoomClickHandlers();

  // Check every minute if it is still Peak Heat Hours
  // setInterval(checkPeakHeatHours, 60000); // 60000 ms = 1 minute

  // Initialize Three.js viewer
  initThreeJS();

  // Initialize Sparkline Chart
  initSparkline();

  // Start listening to Firestore data
  listenToData();

  // Initialize AI Chat
  initAIChat();

  // Start listening to thermal data for all rooms
  listenToThermal('room1');
  listenToThermal('room2');

  // Heatmap toggle control
const heatmapToggle = document.getElementById('heatmap-toggle');

if (heatmapToggle) {
  heatmapToggle.addEventListener('change', (e) => {
    isHeatmapEnabled = e.target.checked;
    console.log('Heatmap enabled:', isHeatmapEnabled);
  });
}

};
