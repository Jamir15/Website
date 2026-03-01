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

    const T = tempC * 9/5 + 32; // Convert to Fahrenheit
    const R = humidity;

    let HI_F;

    // ============================================================
    // 1️⃣ Below 20°C → Heat index equals air temperature
    // ============================================================
    if (tempC < 20) {
        return Number(tempC.toFixed(1));
    }

    // ============================================================
    // 2️⃣ 20°C–26°C → Steadman simple approximation
    // ============================================================
    if (tempC >= 20 && tempC < 26.7) {

        HI_F = 0.5 * (
            T +
            61.0 +
            ((T - 68.0) * 1.2) +
            (R * 0.094)
        );

        // NOAA recommendation: if result >= 80°F, switch to Rothfusz
        if (HI_F < 80) {
            const HI_C = (HI_F - 32) * 5/9;
            return Number(Math.max(HI_C, tempC).toFixed(1));
        }
        // Otherwise fall through to Rothfusz
    }

    // ============================================================
    // 3️⃣ Rothfusz regression (≥ 26.7°C or Steadman overflow)
    // ============================================================

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
        HI_F -= ((13 - R)/4) *
            Math.sqrt((17 - Math.abs(T - 95)) / 17);
    }

    // High humidity adjustment
    if (R > 85 && T >= 80 && T <= 87) {
        HI_F += ((R - 85)/10) *
            ((87 - T)/5);
    }

    const HI_C = (HI_F - 32) * 5/9;

    // Ensure HI never drops below actual temperature
    return Number(Math.max(HI_C, tempC).toFixed(1));
}

function getHeatIndexLabel(heatIndex) {
    if (heatIndex == null) return null;

    if (heatIndex < 27) return "Normal";
    if (heatIndex < 32) return "Caution";
    if (heatIndex < 41) return "Extreme Caution";
    if (heatIndex < 54) return "Danger";
    return "Extreme Danger";
}

function getHeatIndexAdvisory(heatIndex) {
    if (heatIndex == null) return null;

    if (heatIndex < 27)
        return "Comfortable conditions. No heat-related risk.";

    if (heatIndex < 32)
        return "Fatigue possible with prolonged exposure.";

    if (heatIndex < 41)
        return "Heat cramps and heat exhaustion possible.";

    if (heatIndex < 54)
        return "Heat cramps likely. Heat exhaustion probable.";

    return "Heat stroke highly likely with continued exposure.";
}

module.exports = {
    computeHeatIndex,
    getHeatIndexLabel,
    getHeatIndexAdvisory
};
