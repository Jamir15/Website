#include <LovyanGFX.hpp>
#include <Adafruit_AHTX0.h>
#include <Adafruit_MLX90640.h>
#include <WiFi.h>
#include <HTTPClient.h>
#include <ArduinoJson.h>
#include <Wire.h>
#include <time.h>
#include "myImage.h"

// ================= WIFI =================
const char* ssid = "ROYAL_CABLE_F15E";
const char* password = "022310342";

// ================= FIRESTORE =================
const char* projectID = "dss-database-51609";
const char* apiKey = "AIzaSyCq6MUL63iHYpOrGqoQrWCjDPWhOnNajmQ";
const char* email = "debelenjamirdave90@gmail.com";
const char* passwordFirebase = "Prototype_15";

String idToken;
String refreshToken;
unsigned long tokenExpiryTime = 0;

// ================= TIMING =================
#define MLX_READ_INTERVAL   1000
#define SYNC_INTERVAL       5000

unsigned long lastMLXRead = 0;
unsigned long lastSync = 0;

// ================= DISPLAY =================
class LGFX : public lgfx::LGFX_Device {
  lgfx::Panel_ILI9341 _panel;
  lgfx::Bus_SPI _bus;
public:
  LGFX() {
    auto bcfg = _bus.config();
    bcfg.spi_host = VSPI_HOST;
    bcfg.freq_write = 40000000;
    bcfg.pin_sclk = 18;
    bcfg.pin_mosi = 23;
    bcfg.pin_miso = 19;
    bcfg.pin_dc   = 2;
    _bus.config(bcfg);
    _panel.setBus(&_bus);

    auto pcfg = _panel.config();
    pcfg.pin_cs  = 15;
    pcfg.pin_rst = 4;
    pcfg.panel_width  = 240;
    pcfg.panel_height = 320;
    _panel.config(pcfg);

    setPanel(&_panel);
  }
};
LGFX display;

// ================= SENSORS =================
Adafruit_AHTX0 aht;
Adafruit_MLX90640 mlx;

float thermalFrame[768];
int16_t compressedFrame[768];

float latestTemp = 0;
float latestHum  = 0;

// ================= FIREBASE AUTH =================
bool firebaseSignIn() {
  HTTPClient http;
  String url = "https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=" + String(apiKey);
  http.begin(url);
  http.addHeader("Content-Type", "application/json");

  StaticJsonDocument<256> doc;
  doc["email"] = email;
  doc["password"] = passwordFirebase;
  doc["returnSecureToken"] = true;

  String payload;
  serializeJson(doc, payload);

  int code = http.POST(payload);
  if (code == 200) {
    StaticJsonDocument<2048> response;
    deserializeJson(response, http.getString());

    idToken = response["idToken"].as<String>();
    refreshToken = response["refreshToken"].as<String>();
    int expiresIn = response["expiresIn"].as<int>();
    tokenExpiryTime = millis() + (expiresIn - 60) * 1000;

    Serial.println("Firebase Sign-in Successful");
    http.end();
    return true;
  }

  Serial.println("Firebase Sign-in Failed");
  http.end();
  return false;
}

bool refreshFirebaseToken() {
  Serial.println("Refreshing Firebase Token...");
  HTTPClient http;
  String url = "https://securetoken.googleapis.com/v1/token?key=" + String(apiKey);
  http.begin(url);
  http.addHeader("Content-Type", "application/json");

  StaticJsonDocument<512> doc;
  doc["grant_type"] = "refresh_token";
  doc["refresh_token"] = refreshToken;

  String payload;
  serializeJson(doc, payload);

  int code = http.POST(payload);
  if (code == 200) {
    StaticJsonDocument<2048> response;
    deserializeJson(response, http.getString());

    idToken = response["id_token"].as<String>();
    refreshToken = response["refresh_token"].as<String>();
    int expiresIn = response["expires_in"].as<int>();
    tokenExpiryTime = millis() + (expiresIn - 60) * 1000;

    Serial.println("Token Refresh Successful");
    http.end();
    return true;
  }

  Serial.println("Token Refresh Failed — Re-signing in...");
  http.end();
  return firebaseSignIn();
}

void ensureValidToken() {
  if (millis() >= tokenExpiryTime) {
    refreshFirebaseToken();
  }
}

// ================= FIRESTORE SEND =================
void sendAHT() {
  ensureValidToken();

  HTTPClient http;
  String url = "https://firestore.googleapis.com/v1/projects/" + String(projectID) +
               "/databases/(default)/documents/sensorData/room1_front?key=" + String(apiKey);

  http.begin(url);
  http.addHeader("Content-Type", "application/json");
  http.addHeader("Authorization", "Bearer " + idToken);

  StaticJsonDocument<256> doc;
  JsonObject fields = doc.createNestedObject("fields");
  fields["Temperature"]["doubleValue"] = latestTemp;
  fields["Humidity"]["doubleValue"] = latestHum;

  String json;
  serializeJson(doc, json);

  int code = http.PATCH(json);
  Serial.printf("AHT20 PATCH code: %d\n", code);
  http.end();
}

void sendThermal() {
  ensureValidToken();

  HTTPClient http;
  String url = "https://firestore.googleapis.com/v1/projects/" + String(projectID) +
               "/databases/(default)/documents/thermalRooms/room1?key=" + String(apiKey);

  http.begin(url);
  http.addHeader("Content-Type", "application/json");
  http.addHeader("Authorization", "Bearer " + idToken);

  StaticJsonDocument<40000> doc;
  JsonObject fields = doc.createNestedObject("fields");

  // ===== frame array with correct Firestore structure =====
  JsonObject frame = fields.createNestedObject("frame");
  JsonObject arrObj = frame.createNestedObject("arrayValue");
  JsonArray arr = arrObj.createNestedArray("values");
  for (int i = 0; i < 768; i++) {
    JsonObject v = arr.createNestedObject();
    v["integerValue"] = compressedFrame[i] / 10; // compressed to reduce JSON size
  }

  fields["width"]["integerValue"]  = 32;
  fields["height"]["integerValue"] = 24;

  // ===== timestamp =====
  char buf[25];
  time_t now;
  time(&now);
  struct tm* tmInfo = gmtime(&now);
  sprintf(buf, "%04d-%02d-%02dT%02d:%02d:%02dZ",
          tmInfo->tm_year + 1900,
          tmInfo->tm_mon + 1,
          tmInfo->tm_mday,
          tmInfo->tm_hour,
          tmInfo->tm_min,
          tmInfo->tm_sec);
  fields["timestamp"]["timestampValue"] = String(buf);

  String json;
  serializeJson(doc, json);

  int code = http.PATCH(json);
  Serial.printf("Thermal PATCH code: %d\n", code);
  http.end();
}

// ================= TFT UPDATE =================
void updateTFT() {
  display.fillRect(110, 45, 200, 75, TFT_WHITE);
  display.setCursor(120, 55);
  display.setTextSize(2);
  display.setTextColor(TFT_BLACK);
  display.printf("%.1f C", latestTemp);

  display.fillRect(115, 175, 200, 75, TFT_WHITE);
  display.setCursor(120, 180);
  display.printf("%.1f %%", latestHum);
}

// ================= SETUP =================
void setup() {
  Serial.begin(115200);

  display.init();
  display.setRotation(1);
  display.setSwapBytes(true);
  display.pushImage(0, 0, 320, 240, TFT2);

  Wire.begin(21, 22);
  Wire.setClock(400000);

  if (!aht.begin()) {
    Serial.println("AHT20 not detected");
    while (1);
  }

  if (!mlx.begin(MLX90640_I2CADDR_DEFAULT, &Wire)) {
    Serial.println("MLX90640 not detected");
    while (1);
  }

  mlx.setMode(MLX90640_CHESS);
  mlx.setResolution(MLX90640_ADC_18BIT);
  mlx.setRefreshRate(MLX90640_4_HZ);

  WiFi.begin(ssid, password);
  while (WiFi.status() != WL_CONNECTED) delay(500);

  configTime(8 * 3600, 0, "pool.ntp.org");

  firebaseSignIn();
}

// ================= LOOP =================
void loop() {
  unsigned long now = millis();

  if (now - lastMLXRead >= MLX_READ_INTERVAL) {
    lastMLXRead = now;
    if (mlx.getFrame(thermalFrame) == 0) {
      for (int i = 0; i < 768; i++) {
        compressedFrame[i] = thermalFrame[i] * 100;
      }
    }
  }

  if (now - lastSync >= SYNC_INTERVAL) {
    lastSync = now;

    sensors_event_t h, t;
    aht.getEvent(&h, &t);
    latestTemp = t.temperature;
    latestHum  = h.relative_humidity;

    updateTFT();
    sendAHT();
    sendThermal();

    Serial.println("5-second cloud sync complete");
  }
}