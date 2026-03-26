# 🌡️ Smart Classroom Monitoring System

### Digital Twin + Heat Index Decision Support System

## 📌 Overview

The **Smart Classroom Monitoring System** is an IoT-based environmental monitoring platform that integrates:

* 📡 Real-time sensor data collection (Temperature, Humidity, Thermal Imaging)
* 🧠 Heat Index computation using NOAA-based formulas
* 🖥️ Web-based Digital Twin Dashboard (3D Visualization)
* 🤖 AI-powered Natural Language Decision Support System (NLDSS)

The system is designed to support **classroom safety evaluation** using **CDRRMO heat index thresholds** for decision-making.

---

## 🎯 Key Features

### 🔹 Real-Time Monitoring

* Temperature & Humidity via AHT20 sensors
* Thermal imaging via MLX90640 (32×24 array)
* Dual-node setup (front & back of classroom)

### 🔹 Heat Index Computation

* Uses:

  * Steadman Approximation (20°C–26.7°C)
  * Rothfusz Regression (≥26.7°C)
* Based on **NOAA / NWS standards**

### 🔹 Digital Twin Visualization

* 3D classroom using **Three.js**
* Volumetric heat propagation (12 depth slices)
* Real-time heatmap rendering

### 🔹 Decision Support System (DSS)

* Heat Index classification:

  * Normal
  * Caution
  * Extreme Caution
  * Danger
  * Extreme Danger
* Advisory based on **CDRRMO thresholds**

### 🔹 AI Assistant

* Natural language explanation of conditions
* Strict rule-based interpretation (no recalculation/prediction)
* Uses OpenAI API (`gpt-4o-mini`)

### 🔹 Fault-Tolerant System

* Backend fallback mode
* Sensor watchdog (6s timeout)
* Local heat index estimation if backend fails

---

## 🏗️ System Architecture

### 📡 Data Flow

1. ESP32 sensors collect data
2. Data sent to **Firebase Firestore**
3. Backend processes:

   * Averaging
   * Heat index computation
   * Advisory generation
4. Frontend dashboard visualizes:

   * Sensor values
   * Heatmap
   * AI explanation

---

## ⚙️ Tech Stack

### 🔹 Hardware

* ESP32 / ESP32-C3
* AHT20 (Temperature & Humidity)
* MLX90640 (Thermal Camera)
* TFT Display (ILI9341)

### 🔹 Backend

* Node.js
* Express.js
* Firebase Admin SDK
* OpenAI API

### 🔹 Frontend

* Vanilla JavaScript
* Three.js (3D visualization)
* Chart.js (graphs)
* Firebase Firestore SDK

### 🔹 Database

* Firebase Firestore (Real-time NoSQL)

---

## 📁 Project Structure

```
Backend/
 ├── ai/
 │   └── heatIndexAssistantPrompt.js
 ├── dss/
 │   └── heatIndex.js
 ├── services/
 │   └── openaiService.js
 ├── server.js
 ├── package.json

Frontend/
 ├── index.html
 ├── index.css
 ├── main.js
 ├── chatAi.js

Prototype Codes/
 ├── room1_front
 ├── room1_back
 ├── room2_front
 ├── room2_back
```

---

## 🔥 Heat Index Categories

| Range (°C) | Category        | Description               |
| ---------- | --------------- | ------------------------- |
| < 27       | Normal          | Comfortable               |
| 27–32      | Caution         | Fatigue possible          |
| 33–41      | Extreme Caution | Heat cramps possible      |
| 42–51      | Danger          | Heat exhaustion likely    |
| ≥ 52       | Extreme Danger  | Heat stroke highly likely |

---

## 🚀 Installation & Setup

### 🔹 Backend Setup

```bash
cd backend
npm install
```

Create `.env` file:

```env
OPENAI_API_KEY=your_openai_key
FIREBASE_SERVICE_ACCOUNT=your_json_string
```

Run server:

```bash
node server.js
```

---

### 🔹 Frontend Setup

Simply open:

```
index.html
```

or deploy using:

* Vercel / Netlify / Render

---

### 🔹 ESP32 Setup

* Install required libraries:

  * WiFi
  * HTTPClient
  * ArduinoJson
  * Adafruit_AHTX0
  * Adafruit_MLX90640
  * LovyanGFX

* Update:

  * WiFi credentials
  * Firebase API key

Upload code to:

* Room Front Node
* Room Back Node

---

## 📡 API Endpoints

### GET Room Data

```
GET /api/:roomName
```

Response:

```json
{
  "room1": {
    "averageTemperature": 30.5,
    "averageHumidity": 65.2,
    "heatIndex": 38.1,
    "label": "Extreme Caution",
    "advisory": [...],
    "thermal": {...},
    "timestamp": 1710000000000
  }
}
```

---

### POST AI Explanation

```
POST /api/ai/heat-index
```

Body:

```json
{
  "temperature": 30,
  "humidity": 65,
  "heatIndex": 38,
  "label": "Extreme Caution",
  "advisory": [...],
  "question": "Is it safe?"
}
```

---

## 🛡️ Safety & Limitations

* AI does **NOT**:

  * Recalculate heat index
  * Predict future conditions
  * Provide medical advice

* System depends on:

  * Sensor reliability
  * Network connectivity

---

## 📊 Research Context

This system supports:

* **CDRRMO heat index thresholds**
* Classroom safety evaluation
* Data-driven decision-making (e.g., class suspension)

---

## 👨‍💻 Developers

* De Belen, Jamir Dave A.
* Aguila, Claudette L.
* Alipala, Sherwin P.
* Bosito, Carl Francis M.
* Tomalin, Rahnd Bertte J.

**Pamantasan ng Cabuyao – BS Computer Engineering**

---

## 📄 License

This project is for **academic and research purposes only**.
