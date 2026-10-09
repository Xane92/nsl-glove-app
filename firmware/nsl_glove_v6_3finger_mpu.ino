/*
 * ==========================================================
 *  NSL GLOVE  -  Nigerian Sign Language to Speech
 *  ESP32-WROOM-32 | 3x Flex Sensors | MPU-9250 | Bluetooth SPP
 * ==========================================================
 *
 *  WHAT'S NEW IN v4
 *    Adds an MPU-9250 motion sensor for HAND TILT.
 *    Each sign can be trained two ways:
 *      - SAVE   : fingers only  (orientation ignored)
 *      - SAVEM  : fingers + tilt (orientation matters)
 *    A sign trained with SAVE matches on finger bend alone, so tilting
 *    your hand won't break it. A sign trained with SAVEM also checks tilt,
 *    so two signs with the same fingers but different hand rotation can be
 *    told apart. Each sign stores its own flag, so the two kinds never
 *    interfere with each other.
 *
 *  FLEX WIRING (voltage divider per finger, resistors in the box)
 *    3V3 --- [FLEX SENSOR] ---+--- ADC PIN
 *                             |
 *                            [10k]
 *                             |
 *                            GND
 *
 *  FLEX PIN MAP (ADC1 only - ADC2 is unusable while the radio is on)
 *    Middle -> GPIO 34
 *    Ring   -> GPIO 35
 *    Pinky  -> GPIO 32
 *    (Thumb GPIO36 + Index GPIO39 dropped - dead sensors)
 *
 *  MPU-9250 WIRING (I2C)
 *    VCC -> 3.3V   (NOT 5V)
 *    GND -> GND
 *    SDA -> GPIO 21
 *    SCL -> GPIO 22
 *    Leave every other MPU pin empty.
 *
 *  BLUETOOTH COMMANDS (from the phone app)
 *    TRAIN:HELLO   arm recording for the label "HELLO"
 *    SAVE          capture current pose - FINGERS ONLY
 *    SAVEM         capture current pose - FINGERS + TILT
 *    DONE          stop training the current word
 *    LIST          list every stored sign (shows +tilt where used)
 *    DEL:HELLO     delete all samples of one sign
 *    CLEAR         wipe all signs
 *    CAL           re-run the open-hand / fist finger calibration
 *    RAW           dump live finger + tilt values (diagnostic)
 * ==========================================================
 */

#include "BluetoothSerial.h"
#include <Preferences.h>
#include <Wire.h>

// ---------------- CONFIG ----------------
#define NUM_FINGERS   3
#define NUM_TILT      3            // aX, aY, aZ
#define MAX_SIGNS     100
#define LABEL_LEN     20

// How close a live reading must be to a stored sign to count as a match.
// Raise it if signs are not being detected. Lower it if the wrong sign fires.
#define MATCH_THRESHOLD   28.0

// How much the tilt axes count relative to fingers, for tilt-aware sign.
// Fingers are on a 0-100 scale; tilt is normalised to 0-100 too, but tilt
// naturally swings less per sign, so this weight scales its contribution.
// Raise if orientation should matter more; lower if tilt causes wrong fires.
#define TILT_WEIGHT       0.6

// How many identical consecutive reads before we speak. Stops flickering.
#define STABLE_COUNT      6
#define LOOP_DELAY_MS     40
#define ADC_SAMPLES       64

const int FLEX_PIN[NUM_FINGERS] = {34, 35, 36};
const char* FINGER_NAME[NUM_FINGERS] = {"Middle", "Ring", "Pinky"};

#define LED_PIN     2

// MPU-9250 over I2C
#define MPU_ADDR      0x68
#define REG_PWR_MGMT  0x6B
#define REG_ACCEL     0x3B
#define SDA_PIN       21
#define SCL_PIN       22

// ---------------- STATE ----------------
BluetoothSerial BT;
Preferences prefs;

struct Sign {
  char  label[LABEL_LEN];
  float pose[NUM_FINGERS];    // normalised 0-100 per finger
  float tilt[NUM_TILT];       // normalised 0-100 per axis
  bool  useTilt;              // does this sign care about orientation?
};

Sign  signBank[MAX_SIGNS];
int   signCount = 0;

int   rawMin[NUM_FINGERS];    // reading with hand fully OPEN
int   rawMax[NUM_FINGERS];    // reading with hand fully CLOSED

bool  mpuOk = false;          // did the MPU respond at boot?

bool  armedForTraining = false;
char  pendingLabel[LABEL_LEN] = {0};

String lastSpoken = "";
String candidate  = "";
int    stableHits = 0;

// Forward declaration (blink is defined lower but used above it).
void blink(int times, int ms);

// ==========================================================
//  MPU-9250  (I2C tilt sensor)
// ==========================================================

uint8_t mpuReadByte(uint8_t reg) {
  Wire.beginTransmission(MPU_ADDR);
  Wire.write(reg);
  Wire.endTransmission(false);
  Wire.requestFrom(MPU_ADDR, 1, true);
  return Wire.available() ? Wire.read() : 0;
}

void mpuWriteByte(uint8_t reg, uint8_t val) {
  Wire.beginTransmission(MPU_ADDR);
  Wire.write(reg);
  Wire.write(val);
  Wire.endTransmission(true);
}

bool mpuBegin() {
  Wire.begin(SDA_PIN, SCL_PIN);
  Wire.setClock(400000);
  mpuWriteByte(REG_PWR_MGMT, 0x00);   // wake from sleep
  delay(100);
  uint8_t who = mpuReadByte(0x75);    // WHO_AM_I
  // Accept any live response (0x68/0x70/0x71/0x73 across variants).
  return (who != 0x00 && who != 0xFF);
}

// Read the three accelerometer axes (raw signed, roughly -16000..16000).
void mpuReadAccel(int16_t &ax, int16_t &ay, int16_t &az) {
  Wire.beginTransmission(MPU_ADDR);
  Wire.write(REG_ACCEL);
  Wire.endTransmission(false);
  Wire.requestFrom(MPU_ADDR, 6, true);
  if (Wire.available() < 6) { ax = ay = az = 0; return; }
  ax = (Wire.read() << 8) | Wire.read();
  ay = (Wire.read() << 8) | Wire.read();
  az = (Wire.read() << 8) | Wire.read();
}

// Map a raw accel axis (-16384..16384 = -1g..+1g at default range) to 0-100.
float normaliseTilt(int16_t raw) {
  float v = (float)(raw + 16384) * 100.0 / 32768.0;
  if (v < 0)   v = 0;
  if (v > 100) v = 100;
  return v;
}

// Read tilt as three normalised 0-100 values. Averages a few samples.
void readTilt(float out[NUM_TILT]) {
  if (!mpuOk) { out[0] = out[1] = out[2] = 0; return; }
  long sx = 0, sy = 0, sz = 0;
  const int N = 4;
  for (int i = 0; i < N; i++) {
    int16_t ax, ay, az;
    mpuReadAccel(ax, ay, az);
    sx += ax; sy += ay; sz += az;
    delay(4);
  }
  out[0] = normaliseTilt(sx / N);
  out[1] = normaliseTilt(sy / N);
  out[2] = normaliseTilt(sz / N);
}

// ==========================================================
//  FLEX SENSOR READING
// ==========================================================

int readRaw(int finger) {
  long sum = 0;
  for (int i = 0; i < ADC_SAMPLES; i++) {
    sum += analogRead(FLEX_PIN[finger]);
    delayMicroseconds(200);
  }
  return sum / ADC_SAMPLES;
}

// Map raw ADC to a clean 0-100 scale. 0 = straight, 100 = fully bent.
float normalise(int finger, int raw) {
  int lo = rawMin[finger];
  int hi = rawMax[finger];
  if (abs(hi - lo) < 40) return 0;
  float v = (float)(raw - lo) * 100.0 / (float)(hi - lo);
  if (v < 0)   v = 0;
  if (v > 100) v = 100;
  return v;
}

void readFingers(float out[NUM_FINGERS]) {
  for (int i = 0; i < NUM_FINGERS; i++) {
    out[i] = normalise(i, readRaw(i));
  }
}

// ==========================================================
//  PERSISTENCE
// ==========================================================

void saveBank() {
  prefs.begin("nslglove", false);
  prefs.putInt("count", signCount);
  prefs.putBytes("bank", signBank, sizeof(Sign) * MAX_SIGNS);
  prefs.end();
}

void loadBank() {
  prefs.begin("nslglove", true);
  signCount = prefs.getInt("count", 0);
  if (signCount > 0) {
    prefs.getBytes("bank", signBank, sizeof(Sign) * MAX_SIGNS);
  }
  for (int i = 0; i < NUM_FINGERS; i++) {
    rawMin[i] = prefs.getInt(("mn" + String(i)).c_str(), 0);
    rawMax[i] = prefs.getInt(("mx" + String(i)).c_str(), 0);
  }
  prefs.end();
  if (signCount < 0 || signCount > MAX_SIGNS) signCount = 0;
}

void saveCalibration() {
  prefs.begin("nslglove", false);
  for (int i = 0; i < NUM_FINGERS; i++) {
    prefs.putInt(("mn" + String(i)).c_str(), rawMin[i]);
    prefs.putInt(("mx" + String(i)).c_str(), rawMax[i]);
  }
  prefs.end();
}

// ==========================================================
//  CALIBRATION  (fingers only - tilt needs no calibration)
// ==========================================================

int steadyRead(int finger) {
  long sum = 0;
  const int N = 5;
  for (int i = 0; i < N; i++) { sum += readRaw(finger); delay(20); }
  return sum / N;
}

void calibratePhase(const char* prompt, int out[NUM_FINGERS]) {
  BT.printf(">> %s\n", prompt);
  BT.flush();
  for (int s = 5; s > 0; s--) {
    BT.printf(">> %d...\n", s);
    BT.flush();
    blink(1, 120);
    delay(880);
  }
  BT.println(">> Hold still, reading...");
  BT.flush();
  delay(300);
  for (int i = 0; i < NUM_FINGERS; i++) out[i] = steadyRead(i);
  BT.println(">> Got it.");
  BT.flush();
  blink(2, 90);
}

void calibrate() {
  BT.println(">> CALIBRATION START");
  calibratePhase("Open your hand FLAT.", rawMin);
  calibratePhase("Now make a tight FIST.", rawMax);

  for (int i = 0; i < NUM_FINGERS; i++) {
    if (rawMin[i] > rawMax[i]) { int t = rawMin[i]; rawMin[i] = rawMax[i]; rawMax[i] = t; }
  }
  saveCalibration();

  BT.println(">> Calibration saved:");
  for (int i = 0; i < NUM_FINGERS; i++) {
    BT.printf(">> %-7s open=%4d  bent=%4d  span=%4d %s\n",
              FINGER_NAME[i], rawMin[i], rawMax[i],
              rawMax[i] - rawMin[i],
              (rawMax[i] - rawMin[i] < 40) ? " CHECK WIRING" : "");
  }
  blink(3, 120);
}

// ==========================================================
//  TRAINING
// ==========================================================

// withTilt = true when the app sent SAVEM (fingers + orientation).
void captureSign(bool withTilt) {
  if (!armedForTraining) {
    BT.println("!! Not armed. Send TRAIN:<WORD> from the app first.");
    return;
  }
  if (signCount >= MAX_SIGNS) {
    BT.println("!! Sign bank full. Delete some signs (DEL:<WORD>) or CLEAR.");
    return;
  }
  if (withTilt && !mpuOk) {
    BT.println("!! Motion sensor not detected - saving fingers only.");
    withTilt = false;
  }

  float fingers[NUM_FINGERS];
  readFingers(fingers);
  float tilt[NUM_TILT] = {0, 0, 0};
  if (withTilt) readTilt(tilt);

  int slot = signCount++;
  strncpy(signBank[slot].label, pendingLabel, LABEL_LEN - 1);
  signBank[slot].label[LABEL_LEN - 1] = '\0';
  for (int i = 0; i < NUM_FINGERS; i++) signBank[slot].pose[i] = fingers[i];
  for (int i = 0; i < NUM_TILT; i++)    signBank[slot].tilt[i] = tilt[i];
  signBank[slot].useTilt = withTilt;

  saveBank();

  int samples = 0;
  for (int i = 0; i < signCount; i++) {
    if (strcmp(signBank[i].label, pendingLabel) == 0) samples++;
  }

  BT.printf(">> SAVED \"%s\" (sample %d)%s  [", signBank[slot].label, samples,
            withTilt ? " +tilt" : "");
  for (int i = 0; i < NUM_FINGERS; i++) BT.printf("%3.0f ", fingers[i]);
  if (withTilt) { BT.print("| "); for (int i = 0; i < NUM_TILT; i++) BT.printf("%3.0f ", tilt[i]); }
  BT.println("]");

  BT.println(">> Still armed. Tap SAVE/SAVEM again to add another, or send DONE.");
  blink(2, 100);
}

// ==========================================================
//  CLASSIFICATION  -  nearest neighbour, tilt-aware per sign
// ==========================================================

String classify(float fingers[NUM_FINGERS], float tilt[NUM_TILT]) {
  if (signCount == 0) return "";

  float bestDist = 1e9;
  int   bestIdx  = -1;

  for (int s = 0; s < signCount; s++) {
    float sum = 0;
    // Fingers always count.
    for (int i = 0; i < NUM_FINGERS; i++) {
      float d = fingers[i] - signBank[s].pose[i];
      sum += d * d;
    }
    // Tilt counts ONLY for signs trained with SAVEM.
    if (signBank[s].useTilt) {
      for (int i = 0; i < NUM_TILT; i++) {
        float d = (tilt[i] - signBank[s].tilt[i]) * TILT_WEIGHT;
        sum += d * d;
      }
    }
    float dist = sqrt(sum);
    if (dist < bestDist) { bestDist = dist; bestIdx = s; }
  }

  if (bestIdx >= 0 && bestDist <= MATCH_THRESHOLD) {
    return String(signBank[bestIdx].label);
  }
  return "";
}

// ==========================================================
//  COMMANDS FROM THE PHONE
// ==========================================================

void handleCommand(String cmd) {
  cmd.trim();
  if (cmd.length() == 0) return;

  if (cmd.startsWith("TRAIN:")) {
    String lbl = cmd.substring(6);
    lbl.trim();
    lbl.toUpperCase();
    if (lbl.length() == 0) { BT.println("!! Usage: TRAIN:HELLO"); return; }
    strncpy(pendingLabel, lbl.c_str(), LABEL_LEN - 1);
    pendingLabel[LABEL_LEN - 1] = '\0';
    armedForTraining = true;
    BT.printf(">> ARMED for \"%s\". Hold the sign, tap SAVE (or SAVEM for tilt). DONE when finished.\n", pendingLabel);
    blink(1, 400);
  }
  else if (cmd == "SAVE") {
    captureSign(false);
  }
  else if (cmd == "SAVEM") {
    captureSign(true);
  }
  else if (cmd == "DONE") {
    if (armedForTraining) {
      BT.printf(">> Done training \"%s\".\n", pendingLabel);
    } else {
      BT.println(">> Not training.");
    }
    armedForTraining = false;
    pendingLabel[0] = '\0';
  }
  else if (cmd == "LIST") {
    BT.printf(">> %d sample(s) stored:\n", signCount);
    char shown[MAX_SIGNS][LABEL_LEN];
    int  shownCount = 0;
    for (int i = 0; i < signCount; i++) {
      bool already = false;
      for (int k = 0; k < shownCount; k++) {
        if (strcmp(shown[k], signBank[i].label) == 0) { already = true; break; }
      }
      if (already) continue;
      int samples = 0;
      bool anyTilt = false;
      for (int j = 0; j < signCount; j++) {
        if (strcmp(signBank[j].label, signBank[i].label) == 0) {
          samples++;
          if (signBank[j].useTilt) anyTilt = true;
        }
      }
      BT.printf(">> %-12s x%d%s\n", signBank[i].label, samples, anyTilt ? "  +tilt" : "");
      strncpy(shown[shownCount], signBank[i].label, LABEL_LEN - 1);
      shown[shownCount][LABEL_LEN - 1] = '\0';
      shownCount++;
    }
    if (signCount == 0) BT.println(">> (none yet)");
  }
  else if (cmd.startsWith("DEL:")) {
    String lbl = cmd.substring(4); lbl.trim(); lbl.toUpperCase();
    int removed = 0;
    int i = 0;
    while (i < signCount) {
      if (strcmp(signBank[i].label, lbl.c_str()) == 0) {
        for (int j = i; j < signCount - 1; j++) signBank[j] = signBank[j + 1];
        signCount--;
        removed++;
      } else {
        i++;
      }
    }
    if (removed > 0) {
      saveBank();
      BT.printf(">> Deleted \"%s\" (%d sample(s)).\n", lbl.c_str(), removed);
    } else {
      BT.println("!! Not found.");
    }
  }
  else if (cmd == "CLEAR") {
    signCount = 0;
    saveBank();
    BT.println(">> All signs cleared.");
  }
  else if (cmd == "CAL") {
    calibrate();
  }
  else if (cmd == "RAW") {
    for (int i = 0; i < NUM_FINGERS; i++) {
      int r = readRaw(i);
      BT.printf(">> %-7s raw=%4d  norm=%3.0f\n", FINGER_NAME[i], r, normalise(i, r));
    }
    if (mpuOk) {
      float t[NUM_TILT];
      readTilt(t);
      BT.printf(">> Tilt    aX=%3.0f  aY=%3.0f  aZ=%3.0f\n", t[0], t[1], t[2]);
    } else {
      BT.println(">> Tilt    (MPU not detected)");
    }
  }
  else {
    BT.println("!! Commands: TRAIN:<WORD> | SAVE | SAVEM | DONE | LIST | DEL:<WORD> | CLEAR | CAL | RAW");
  }
}

// ==========================================================
//  HELPERS
// ==========================================================

void blink(int times, int ms) {
  for (int i = 0; i < times; i++) {
    digitalWrite(LED_PIN, HIGH); delay(ms);
    digitalWrite(LED_PIN, LOW);  delay(ms);
  }
}

// ==========================================================
//  SETUP / LOOP
// ==========================================================

void setup() {
  Serial.begin(115200);
  pinMode(LED_PIN, OUTPUT);

  analogReadResolution(12);
  for (int i = 0; i < NUM_FINGERS; i++) {
    analogSetPinAttenuation(FLEX_PIN[i], ADC_11db);
  }

  BT.begin("NSL_Glove");
  mpuOk = mpuBegin();
  loadBank();

  // ---- ONE-TIME AUTO-WIPE ON FLASH ----
  // v4 changes the sign data shape (fingers + tilt + flag), so old signs are
  // incompatible. WIPE_TAG bumped to force exactly one clean wipe on flash.
  const int WIPE_TAG = 3001;
  prefs.begin("nslglove", false);
  int lastWipe = prefs.getInt("wipetag", 0);
  if (lastWipe != WIPE_TAG) {
    prefs.clear();
    prefs.putInt("wipetag", WIPE_TAG);
    signCount = 0;
    for (int i = 0; i < NUM_FINGERS; i++) { rawMin[i] = 0; rawMax[i] = 0; }
    prefs.end();
    loadBank();
    BT.println(">> FRESH START: signs cleared for v4 (fingers + tilt).");
  } else {
    prefs.end();
  }
  // --------------------------------------

  delay(600);
  BT.println(">> =================================");
  BT.println(">> NSL GLOVE v4 READY");
  BT.printf (">> %d sign(s) in memory\n", signCount);
  BT.printf (">> Motion sensor: %s\n", mpuOk ? "OK" : "NOT FOUND");
  BT.println(">> TRAIN | SAVE | SAVEM | LIST | CAL | RAW");
  BT.println(">> =================================");

  bool needCal = false;
  for (int i = 0; i < NUM_FINGERS; i++) {
    if (abs(rawMax[i] - rawMin[i]) < 40) needCal = true;
  }
  if (needCal) {
    BT.println(">> No calibration found. Send CAL to calibrate.");
  }

  blink(2, 150);
}

void loop() {
  // 1. Commands from the phone
  while (BT.available()) {
    String line = BT.readStringUntil('\n');
    handleCommand(line);
  }

  // 2. Translate
  if (!armedForTraining) {
    float fingers[NUM_FINGERS];
    readFingers(fingers);
    float tilt[NUM_TILT];
    readTilt(tilt);

    String match = classify(fingers, tilt);

    if (match.length() > 0 && match == candidate) {
      stableHits++;
    } else {
      candidate  = match;
      stableHits = (match.length() > 0) ? 1 : 0;
    }

    if (stableHits == STABLE_COUNT && candidate != lastSpoken) {
      BT.println(candidate);
      Serial.println(candidate);
      lastSpoken = candidate;
      blink(1, 60);
    }

    if (match.length() == 0) lastSpoken = "";
  }

  delay(LOOP_DELAY_MS);
}
