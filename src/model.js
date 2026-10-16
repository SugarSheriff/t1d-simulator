// Simplified type 1 diabetes physiology model.
// Educational only. This is NOT a medical model and must never be used for dosing decisions.
(function () {
  const T1D = (window.T1D = window.T1D || {});

  const PROFILE = {
    carbRatio: 10, // grams of carbs covered by 1 unit of rapid insulin
    isf: 40, // mg/dL drop from 1 unit of rapid insulin
    target: 110,
    basalUnits: 20, // long-acting units, once a day
  };
  const CSF = PROFILE.isf / PROFILE.carbRatio; // mg/dL rise per gram of carbs
  const BASE_EGP = (PROFILE.basalUnits * PROFILE.isf) / 1440; // liver output that basal is meant to cancel

  // Exponential insulin action curve (same shape many open-source dosing apps use).
  function expCurve(td, tp) {
    const tau = (tp * (1 - tp / td)) / (1 - (2 * tp) / td);
    const a = (2 * tau) / td;
    const S = 1 / (1 - a + (1 + a) * Math.exp(-td / tau));
    return {
      activity(t) {
        if (t <= 0 || t >= td) return 0;
        return (S / (tau * tau)) * t * (1 - t / td) * Math.exp(-t / tau);
      },
      iob(t) {
        if (t <= 0) return 1;
        if (t >= td) return 0;
        return 1 - S * (1 - a) * ((t * t / (tau * td * (1 - a)) - t / tau - 1) * Math.exp(-t / tau) + 1);
      },
    };
  }
  const RAPID = expCurve(300, 75);

  // Long-acting: ramps up over an hour, flat for a day, tapers off over the next 2 hours.
  function basalRate(age) {
    let shape = 0;
    if (age < 0) shape = 0;
    else if (age < 60) shape = age / 60;
    else if (age < 1440) shape = 1;
    else if (age < 1560) shape = (1560 - age) / 120;
    return shape / 1440;
  }

  // Triangular carb absorption after an optional delay (fat and protein slow things down).
  function carbRate(age, c) {
    const x = age - c.delay;
    const D = c.duration;
    if (x <= 0 || x >= D) return 0;
    return x < D / 2 ? (4 * x) / (D * D) : (4 * (D - x)) / (D * D);
  }
  function carbAbsorbed(age, c) {
    const x = age - c.delay;
    const D = c.duration;
    if (x <= 0) return 0;
    if (x >= D) return 1;
    return x < D / 2 ? (2 * x * x) / (D * D) : 1 - (2 * (D - x) * (D - x)) / (D * D);
  }

  const FOODS = {
    tabs: { name: "Glucose tabs (4)", label: "16 g", min: 16, max: 16, duration: 25, delay: 3, fast: true },
    juice: { name: "Juice box", label: "15 g", min: 15, max: 15, duration: 30, delay: 5, fast: true },
    apple: { name: "Apple", label: "~20 g", min: 15, max: 26, duration: 70, delay: 10 },
    granola: { name: "Granola bar", label: "25 g", min: 23, max: 28, duration: 75, delay: 10 },
    cereal: { name: "Cereal & milk", label: "~50 g", min: 44, max: 62, duration: 70, delay: 5 },
    eggs: { name: "Eggs & toast", label: "~15 g", min: 12, max: 20, duration: 100, delay: 15 },
    sandwich: { name: "Sandwich", label: "~45 g", min: 38, max: 56, duration: 120, delay: 15 },
    salad: { name: "Chicken salad", label: "~10 g", min: 6, max: 15, duration: 90, delay: 15 },
    pasta: { name: "Pasta", label: "~80 g", min: 65, max: 98, duration: 150, delay: 15 },
    pizza: { name: "Pizza (2 slices)", label: "~70 g", min: 58, max: 92, duration: 240, delay: 60 },
    donut: { name: "Donut", label: "~30 g?", min: 28, max: 50, duration: 60, delay: 5 },
    bbq: { name: "BBQ plate + sides", label: "~75 g?", min: 60, max: 112, duration: 210, delay: 35 },
    cake: { name: "Birthday cake", label: "~40 g?", min: 35, max: 62, duration: 70, delay: 10 },
  };
  T1D.MENU = ["tabs", "juice", "apple", "granola", "cereal", "eggs", "sandwich", "salad", "pasta", "pizza"];

  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const gauss = () => Math.sqrt(-2 * Math.log(1 - Math.random())) * Math.cos(2 * Math.PI * Math.random());
  const tod = (t) => ((t % 1440) + 1440) % 1440;
  const rand = (a, b) => a + Math.random() * (b - a);

  // Afternoon heat. Peaks around 4pm.
  function temperature(t) {
    const h = tod(t) / 60;
    const x = Math.cos(((h - 16) / 24) * 2 * Math.PI);
    return Math.round(76 + 20 * x);
  }

  function createState(t0) {
    return {
      t: t0,
      dayStart: t0,
      day: 1,
      bg: rand(115, 140),
      // Yesterday's long-acting dose, taken at 7:00 AM. It runs out this morning.
      basals: [{ t: tod(7 * 60) - 1440 + (t0 - tod(t0)), units: PROFILE.basalUnits, potency: 1 }],
      boluses: [],
      carbs: [],
      drift: 0,
      stress: 0,
      hiddenRise: 0,
      hydration: 85,
      exerciseBoost: 0,
      sleepDebt: 0,
      ketones: 0.2,
      potency: 1,
      activity: "sit",
      activityStart: t0,
      location: "home",
      heatResponse: null,
      forced: null,
      lowMinutes: 0,
      dead: null,
      cgm: { status: "ok", value: null, trend: 0, nextAt: t0, warmupUntil: 0, errorUntil: 0, errorFails: false, compressionUntil: 0 },
      lastFinger: null,
      history: [],
      readings: [],
      markers: [],
      notes: [],
    };
  }

  function insulinActivity(S, t) {
    let basal = 0;
    for (const b of S.basals) basal += b.units * b.potency * basalRate(t - b.t);
    let bolus = 0;
    for (const b of S.boluses) bolus += b.units * b.potency * RAPID.activity(t - b.t);
    return { basal, bolus };
  }

  function step(S) {
    const t = S.t;
    const h = tod(t) / 60;
    const hot = S.activity === "outside" && temperature(t) >= 85;

    // Things that push glucose up.
    let hormone = 1;
    if (h >= 4 && h < 9) hormone += 0.3; // dawn phenomenon
    hormone += S.stress * 0.7 + S.hiddenRise;
    if (S.hydration < 40) hormone += 0.25;
    const egp = BASE_EGP * hormone;

    // How hard insulin hits right now.
    let sens = 1 + S.exerciseBoost;
    sens *= 1 - Math.min(0.3, S.stress * 0.25);
    sens *= 1 - Math.min(0.2, S.sleepDebt * 0.2);
    if (hot && S.heatResponse === "absorb") sens *= 1.4; // heat speeds insulin absorption
    if (S.ketones > 1.5) sens *= 0.8;

    const ins = insulinActivity(S, t);
    const insulinDrop = (ins.basal + ins.bolus) * PROFILE.isf * sens;

    let carbRise = 0;
    for (const c of S.carbs) carbRise += c.grams * carbRate(t - c.t, c) * CSF;

    let muscle = 0;
    const mins = t - S.activityStart;
    if (S.activity === "walk") muscle = 0.35;
    if (S.activity === "gym") muscle = mins < 12 ? -0.6 : 1.0; // adrenaline spike first, then the drop
    if (hot && S.heatResponse === "stress") muscle -= 0.4; // heat stress hormones push it up

    S.drift = S.drift * 0.97 + gauss() * 0.02; // the "no reason at all" factor
    const kidneys = S.bg > 180 ? (S.bg - 180) * 0.002 : 0;

    S.bg = clamp(S.bg + egp - insulinDrop + carbRise - muscle + S.drift - kidneys, 15, 600);

    // Slow-moving body state.
    S.stress = Math.max(0, S.stress - 0.004);
    S.hiddenRise = Math.max(0, S.hiddenRise - 0.002);
    if (S.activity === "walk" && mins > 20) S.exerciseBoost = Math.max(S.exerciseBoost, 0.2);
    else if (S.activity === "gym" && mins > 20) S.exerciseBoost = Math.max(S.exerciseBoost, 0.5);
    else S.exerciseBoost *= 0.997;

    let thirst = 0.03;
    if (hot) thirst = 0.25;
    else if (S.activity === "gym") thirst = 0.15;
    if (S.bg > 220) thirst += 0.04;
    S.hydration = clamp(S.hydration - thirst, 0, 100);

    const insulinLevel = ins.basal + ins.bolus;
    if (insulinLevel < 0.006) S.ketones += 0.006;
    else if (S.bg > 250) S.ketones += 0.0015;
    else S.ketones -= 0.003;
    S.ketones = clamp(S.ketones, 0.1, 8);

    if (S.bg < 40) S.lowMinutes++;
    else S.lowMinutes = 0;
    if (S.lowMinutes >= 20) S.dead = "low";
    if (S.ketones >= 3.5 && S.bg > 250) S.dead = "dka";

    S.history.push({ t, bg: S.bg });
    if (S.history.length > 3000) S.history.shift();

    // Drop old entries that no longer matter.
    S.boluses = S.boluses.filter((b) => t - b.t < 300);
    S.carbs = S.carbs.filter((c) => t - c.t < c.delay + c.duration);
    S.basals = S.basals.filter((b) => t - b.t < 1560);

    S.t++;
  }

  function bgAt(S, t) {
    for (let i = S.history.length - 1; i >= 0; i--) if (S.history[i].t <= t) return S.history[i].bg;
    return S.history.length ? S.history[0].bg : S.bg;
  }

  // CGM: reads every 5 min, ~10 min behind your blood, a little noisy, and sometimes just wrong.
  function updateCGM(S) {
    const c = S.cgm;
    if (S.t < c.nextAt) return false;
    c.nextAt = S.t + 5;
    if (c.status === "warmup" && S.t >= c.warmupUntil) c.status = "ok";
    if (c.status === "error" && S.t >= c.errorUntil) c.status = c.errorFails ? "failed" : "ok";
    if (c.status !== "ok") {
      c.value = null;
      c.trend = 0;
      S.readings.push({ t: S.t, v: null });
      return true;
    }
    let v = bgAt(S, S.t - 10) * (1 + gauss() * 0.035);
    if (S.t < c.compressionUntil) v -= 40; // lying on the sensor
    v = Math.round(clamp(v, 39, 401));
    let prev = null;
    for (let i = S.readings.length - 1; i >= 0; i--) {
      const r = S.readings[i];
      if (S.t - r.t > 20) break;
      if (r.v != null && S.t - r.t >= 10) {
        prev = r;
        break;
      }
    }
    c.trend = prev ? (v - prev.v) / (S.t - prev.t) : 0;
    c.value = v;
    S.readings.push({ t: S.t, v });
    if (S.readings.length > 700) S.readings.shift();
    return true;
  }

  function iob(S) {
    return S.boluses.reduce((sum, b) => sum + b.units * RAPID.iob(S.t - b.t), 0);
  }
  function cobEstimate(S) {
    return S.carbs.reduce((sum, c) => sum + c.labeled * (1 - carbAbsorbed(S.t - c.t, c)), 0);
  }

  function eat(S, id) {
    const f = FOODS[id];
    const grams = Math.round(rand(f.min, f.max));
    const labeled = parseInt(f.label.replace(/\D/g, ""), 10) || grams;
    S.carbs.push({ t: S.t, grams, labeled, duration: f.duration, delay: f.delay, name: f.name });
    S.markers.push({ t: S.t, type: "carb", label: f.name });
    return { food: f, grams, labeled };
  }
  function bolus(S, units) {
    S.boluses.push({ t: S.t, units, potency: S.potency });
    S.markers.push({ t: S.t, type: "insulin", label: units + "u" });
  }
  function takeBasal(S) {
    S.basals.push({ t: S.t, units: PROFILE.basalUnits, potency: 1 });
    S.markers.push({ t: S.t, type: "basal", label: "LA" });
  }
  function fingerstick(S) {
    const v = Math.round(S.bg * (1 + gauss() * 0.03));
    S.lastFinger = { t: S.t, v };
    S.markers.push({ t: S.t, type: "finger", v });
    return v;
  }

  T1D.model = {
    PROFILE, FOODS, RAPID, createState, step, updateCGM, iob, cobEstimate, eat, bolus, takeBasal,
    fingerstick, temperature, tod, rand, clamp, insulinActivity,
  };
})();
