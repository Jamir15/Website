#include <LovyanGFX.hpp>
#include <Adafruit_AHTX0.h>
#include <WiFi.h>
#include <HTTPClient.h>
#include <ArduinoJson.h>
#include "myImage.h"  // Your base UI image

// =============================
// --- WIFI CONFIGURATION --- 
// =============================
const char* ssid = "ROYAL_CABLE_F15E";
const char* password = "022310342";

// =============================
// --- FIRESTORE CONFIG --- 
// =============================
const char* projectID = "dss-database-51609";  // Firestore project ID
const char* apiKey = "AIzaSyCq6MUL63iHYpOrGqoQrWCjDPWhOnNajmQ";        // Web API Key
const char* email = "debelenjamirdave90@gmail.com";           // Firebase account email
const char* passwordFirebase = "Prototype_15"; // Firebase account password
const char* documentPath = "sensorData/room2_back"; // Document path

String idToken; // Will store Firebase ID token after auth

// =============================
// --- LOVYAN GFX CONFIGURATION --- 
// =============================
class LGFX : public lgfx::LGFX_Device {
  lgfx::Panel_ILI9341 _panel_instance;
  lgfx::Bus_SPI       _bus_instance;
public:
  LGFX(void) {
    {
      auto cfg = _bus_instance.config();
      cfg.spi_host = VSPI_HOST;     
      cfg.freq_write = 40000000;    
      cfg.pin_sclk = 18; cfg.pin_mosi = 23; cfg.pin_miso = 19; cfg.pin_dc = 2;
      _bus_instance.config(cfg);
      _panel_instance.setBus(&_bus_instance);
    }
    {
      auto cfg = _panel_instance.config();
      cfg.pin_cs = 15; cfg.pin_rst = 4;
      cfg.panel_width = 240; cfg.panel_height = 320;
      _panel_instance.config(cfg);
    }
    setPanel(&_panel_instance);
  }
};

LGFX display;
Adafruit_AHTX0 aht;

// =============================
// --- TEMPERATURE DISPLAY --- 
// =============================
#define TEMP_X     120   
#define TEMP_Y     55    
#define TEMP_SX    2.0  
#define TEMP_SY    2.5  
#define TEMP_BG_X  110  
#define TEMP_BG_Y  45   
#define TEMP_BG_W  200  
#define TEMP_BG_H  75   
#define DEG_X      220  
#define DEG_Y      60   
#define DEG_R      5    
#define C_LABEL_X  230  

// =============================
// --- HUMIDITY DISPLAY --- 
// =============================
#define HUM_X      120
#define HUM_Y      180
#define HUM_SX     2.0  
#define HUM_SY     2.5  
#define HUM_BG_X   115  
#define HUM_BG_Y   175  
#define HUM_BG_W   200  
#define HUM_BG_H   75   

// =============================
// --- FUNCTIONS --- 
// =============================
bool firebaseSignIn() {
  HTTPClient http;
  String url = "https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=" + String(apiKey);
  http.begin(url);
  http.addHeader("Content-Type", "application/json");

  String payload = "{\"email\":\"" + String(email) + "\",\"password\":\"" + String(passwordFirebase) + "\",\"returnSecureToken\":true}";
  int httpResponseCode = http.POST(payload);
  if (httpResponseCode == 200) {
    String response = http.getString();
    DynamicJsonDocument doc(1024);
    deserializeJson(doc, response);
    idToken = doc["idToken"].as<String>();
    http.end();
    return true;
  }
  http.end();
  return false;
}

bool updateFirestore(float temperature, float humidity) {
  if (idToken == "") return false;

  HTTPClient http;
  String url = "https://firestore.googleapis.com/v1/projects/" + String(projectID) +
               "/databases/(default)/documents/" + String(documentPath) + "?key=" + String(apiKey);
  http.begin(url);
  http.addHeader("Content-Type", "application/json");
  http.addHeader("Authorization", "Bearer " + idToken);

  // Firestore JSON payload
  String json = "{\"fields\":{\"Temperature\":{\"doubleValue\":" + String(temperature) +
                "},\"Humidity\":{\"doubleValue\":" + String(humidity) + "}}}";

  int httpResponseCode = http.PATCH(json);
  http.end();
  return httpResponseCode >= 200 && httpResponseCode < 300;
}

// =============================
// --- SETUP --- 
// =============================
void setup() {
  Serial.begin(115200);
  delay(100);

  // --- TFT INIT ---
  display.init();
  display.setRotation(1);       
  display.setSwapBytes(true);   
  display.invertDisplay(false); 
  display.pushImage(0, 0, 320, 240, TFT2); // Draw base UI

  // --- SENSOR INIT ---
  if (!aht.begin()) {
    Serial.println("AHT20 not found");
    while(1) delay(10);
  }

  // --- WIFI INIT ---
  Serial.println("Connecting to WiFi...");
  WiFi.begin(ssid, password);
  while(WiFi.status() != WL_CONNECTED) {
    delay(500);
    Serial.print(".");
  }
  Serial.println("\nWiFi Connected! IP Address: " + WiFi.localIP().toString());

  // --- FIREBASE SIGN IN ---
  Serial.println("Signing in to Firebase...");
  if (firebaseSignIn()) Serial.println("Firebase Auth Success!");
  else Serial.println("Firebase Auth Failed!");
}

// =============================
// --- LOOP --- 
// =============================
void loop() {
  sensors_event_t humidity_event, temp_event;
  aht.getEvent(&humidity_event, &temp_event);

  float temperature = temp_event.temperature;
  float relHumidity = humidity_event.relative_humidity;

  Serial.printf("Temperature: %.2f C\n", temperature);
  Serial.printf("Humidity: %.2f %%\n", relHumidity);

  bool fsSuccess = updateFirestore(temperature, relHumidity);
  Serial.print("Firestore updated: "); Serial.println(fsSuccess ? "Success" : "Failed");

  // --- TFT Display Update ---
  display.setFont(&fonts::FreeSansBold12pt7b);
  display.setTextColor(TFT_BLACK);

  // --- Temperature ---
  display.fillRect(TEMP_BG_X, TEMP_BG_Y, TEMP_BG_W, TEMP_BG_H, TFT_WHITE);
  display.setTextSize(TEMP_SX, TEMP_SY);
  display.setCursor(TEMP_X, TEMP_Y);
  display.printf("%.1f", temperature);
  display.drawCircle(DEG_X, DEG_Y, DEG_R, TFT_BLACK);
  display.setCursor(C_LABEL_X, TEMP_Y);
  display.print("C");

  // --- Humidity ---
  display.fillRect(HUM_BG_X, HUM_BG_Y, HUM_BG_W, HUM_BG_H, TFT_WHITE);
  display.setTextSize(HUM_SX, HUM_SY);
  display.setCursor(HUM_X, HUM_Y);
  display.printf("%.1f %%", relHumidity);

  // --- Firestore Status ---
  display.setTextSize(1);
  display.setCursor(10, 300);
  display.fillRect(10, 300, 220, 20, TFT_WHITE);
  if (fsSuccess) {
    display.setTextColor(TFT_GREEN);
    display.print("Firestore updated successfully");
  } else {
    display.setTextColor(TFT_RED);
    display.print("Firestore update FAILED");
  }

  delay(5000); //every 5s
}