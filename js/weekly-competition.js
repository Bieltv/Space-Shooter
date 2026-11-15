(() => {
  const TIME_ZONE = "America/Sao_Paulo";
  const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
  const SEASON_START_AT = Date.parse("2026-11-15T13:00:00Z");
  const WEEKDAYS = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  const AI_SCORE_MULTIPLIERS = [0.2, 0.45, 0.8, 1.5, 5];
  const AI_SCORE_CURVES = [1.6, 1.35, 1.15, 0.95, 0.8];

  function zonedParts(timestamp) {
    return Object.fromEntries(new Intl.DateTimeFormat("en-US", {
      timeZone: TIME_ZONE,
      weekday: "short",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23"
    }).formatToParts(new Date(timestamp)).map(({ type, value }) => [type, value]));
  }

  function timeZoneOffset(timestamp) {
    const parts = zonedParts(timestamp);
    const wallClockAsUtc = Date.UTC(
      Number(parts.year),
      Number(parts.month) - 1,
      Number(parts.day),
      Number(parts.hour),
      Number(parts.minute),
      Number(parts.second)
    );
    return wallClockAsUtc - Math.floor(timestamp / 1000) * 1000;
  }

  function localDateTimeToTimestamp(date, hour) {
    const localAsUtc = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate(), hour);
    let timestamp = localAsUtc - timeZoneOffset(localAsUtc);
    timestamp = localAsUtc - timeZoneOffset(timestamp);
    return timestamp;
  }

  function dateId(date) {
    return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}-${String(date.getUTCDate()).padStart(2, "0")}`;
  }

  function windowForDate(date, weekNumber, startAt) {
    const endDate = new Date(date);
    endDate.setUTCDate(endDate.getUTCDate() + 7);
    return {
      weekId: dateId(date),
      weekNumber,
      startAt,
      endAt: localDateTimeToTimestamp(endDate, 10)
    };
  }

  function currentWindow(now = Date.now()) {
    const parts = zonedParts(now);
    const date = new Date(Date.UTC(
      Number(parts.year),
      Number(parts.month) - 1,
      Number(parts.day) - WEEKDAYS[parts.weekday]
    ));
    let startAt = localDateTimeToTimestamp(date, 10);
    if (now < startAt) {
      date.setUTCDate(date.getUTCDate() - 7);
      startAt = localDateTimeToTimestamp(date, 10);
    }

    if (startAt < SEASON_START_AT) {
      const firstWeek = new Date(Date.UTC(2026, 10, 15));
      return windowForDate(firstWeek, 1, SEASON_START_AT);
    }

    const seasonStartDate = new Date(Date.UTC(2026, 10, 15));
    const weekNumber = Math.floor((date.getTime() - seasonStartDate.getTime()) / WEEK_MS) + 1;
    return windowForDate(date, weekNumber, startAt);
  }

  function windowForId(weekId) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(weekId)) return null;
    const [year, month, day] = weekId.split("-").map(Number);
    const date = new Date(Date.UTC(year, month - 1, day));
    if (dateId(date) !== weekId) return null;
    return windowForDate(date, 1, localDateTimeToTimestamp(date, 10));
  }

  function aiScores({ weeklyScore = 0, bestScore = 0, progress = 0, previousScores = [] } = {}) {
    const score = Number.isSafeInteger(weeklyScore) && weeklyScore > 0 ? weeklyScore : 0;
    const record = Number.isSafeInteger(bestScore) && bestScore > 0 ? bestScore : 0;
    const referenceScore = Math.max(10000, score, Math.floor(record * 0.1));
    const elapsed = Math.max(0, Math.min(1, Number.isFinite(progress) ? progress : 0));
    return AI_SCORE_MULTIPLIERS.map((multiplier, index) => {
      const previous = Number.isSafeInteger(previousScores[index]) && previousScores[index] > 0
        ? previousScores[index]
        : 0;
      const generated = Math.floor(referenceScore * multiplier * Math.pow(elapsed, AI_SCORE_CURVES[index]));
      return Math.max(previous, generated);
    });
  }

  globalThis.WeeklyCompetition = Object.freeze({ currentWindow, windowForId, aiScores });
})();
