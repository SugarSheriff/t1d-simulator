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

  // Every food is a math problem: carbs per serving × how much you're actually eating.
  // `error` is how far reality can drift from that math (labels are close, eyeballing isn't, restaurants are a guess).
  const FOODS = {
    tabs: {
      name: "Glucose tabs", fast: true, duration: 25, delay: 3, error: 0,
      parts: [{ item: "Glucose tab", per: "1 tab", carbs: 4, qty: [3, 4, 5] }],
    },
    juice: {
      name: "Juice box", fast: true, duration: 30, delay: 5, error: 0.02,
      parts: [{ item: "Apple juice", per: "1 box (4.2 oz)", carbs: 15, qty: [1, 2] }],
    },
    apple: {
      name: "Apple", duration: 70, delay: 10, error: 0.2, note: "Apples aren't labeled. Size changes everything.",
      parts: [{ item: "Apple", per: "1 medium apple", carbs: 25, qty: [0.75, 1, 1.25] }],
    },
    granola: {
      name: "Granola bar", duration: 75, delay: 10, error: 0.03,
      parts: [{ item: "Granola bar", per: "1 bar", carbs: 26, qty: [1, 2] }],
    },
    cereal: {
      name: "Cereal & milk", duration: 70, delay: 5, error: 0.12, note: "You poured without measuring. Nobody measures.",
      parts: [
        { item: "Cereal", per: "1 cup", carbs: 24, qty: [1, 1.5, 2] },
        { item: "Milk", per: "1 cup", carbs: 12, qty: [0.5, 1] },
      ],
    },
    eggs: {
      name: "Eggs & toast", duration: 100, delay: 15, error: 0.05,
      parts: [
        { item: "Eggs", per: "2 eggs", carbs: 1, qty: [1] },
        { item: "Toast", per: "1 slice", carbs: 15, qty: [1, 2] },
        { item: "Jam", per: "1 tbsp", carbs: 13, qty: [0, 1] },
      ],
    },
    sandwich: {
      name: "Sandwich", duration: 120, delay: 15, error: 0.06,
      parts: [
        { item: "Bread", per: "1 slice", carbs: 18, qty: [2] },
        { item: "Turkey & cheese", per: "1 serving", carbs: 2, qty: [1] },
        { item: "Chips", per: "1 oz bag", carbs: 15, qty: [0, 1] },
      ],
    },
    salad: {
      name: "Chicken salad", duration: 90, delay: 15, error: 0.1,
      parts: [
        { item: "Greens & chicken", per: "1 bowl", carbs: 6, qty: [1] },
        { item: "Dressing", per: "2 tbsp", carbs: 5, qty: [1, 2] },
        { item: "Croutons", per: "1/4 cup", carbs: 10, qty: [0, 1, 2] },
      ],
    },
    pasta: {
      name: "Pasta", duration: 150, delay: 15, error: 0.12,
      parts: [
        { item: "Spaghetti (cooked)", per: "1 cup", carbs: 43, qty: [1, 1.5, 2] },
        { item: "Marinara", per: "1/2 cup", carbs: 13, qty: [1] },
        { item: "Garlic bread", per: "1 slice", carbs: 20, qty: [0, 1, 2] },
      ],
    },
    pizza: {
      name: "Pizza", duration: 240, delay: 60, error: 0.12, note: "The fat delays it. This one hits hours later.",
      parts: [{ item: "Large pizza", per: "1 slice", carbs: 36, qty: [2, 3] }],
    },
    donut: {
      name: "Donut", duration: 60, delay: 5, error: 0.3, note: "No label. A carb app says glazed donuts run 25–45 g.",
      parts: [{ item: "Glazed donut (app's guess)", per: "1 donut", carbs: 31, qty: [1] }],
    },
    bbq: {
      name: "BBQ plate", duration: 210, delay: 35, error: 0.25, note: "No labels. These are guesses from a carb app. Sauces are sneaky.",
      parts: [
        { item: "Brisket", per: "1 serving", carbs: 0, qty: [1] },
        { item: "BBQ sauce", per: "2 tbsp", carbs: 16, qty: [1, 1.5, 2] },
        { item: "Baked beans", per: "1/2 cup", carbs: 24, qty: [1, 1.5] },
        { item: "Fries", per: "1 small order", carbs: 40, qty: [0, 1] },
        { item: "White bread", per: "1 slice", carbs: 13, qty: [1, 2] },
      ],
    },
    cake: {
      name: "Birthday cake", duration: 70, delay: 10, error: 0.25, note: "Grocery store sheet cake. Frosting is pure sugar.",
      parts: [{ item: "Sheet cake w/ frosting", per: '2"×2" square', carbs: 30, qty: [1, 1.5, 2] }],
    },
  };

  // Rolls how much you're actually eating this time and what the carbs really are.
  function serving(id) {
    const f = FOODS[id];
    const rows = [];
    for (const p of f.parts) {
      const qty = p.qty[Math.floor(Math.random() * p.qty.length)];
      if (qty > 0) rows.push({ item: p.item, per: p.per, carbs: p.carbs, qty });
    }
    const answer = Math.round(rows.reduce((s, r) => s + r.carbs * r.qty, 0));
    const actual = Math.max(0, Math.round(answer * (1 + gauss() * f.error * 0.6)));
    return { id, food: f, rows, answer, actual };
  }
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

  // `counted` is what the player worked out. The body only cares about `actual`.
  function eat(S, serv, counted) {
    const f = serv.food;
    S.carbs.push({ t: S.t, grams: serv.actual, labeled: counted, duration: f.duration, delay: f.delay, name: f.name });
    S.markers.push({ t: S.t, type: "carb", label: f.name });
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
    PROFILE, FOODS, RAPID, createState, step, updateCGM, iob, cobEstimate, serving, eat, bolus, takeBasal,
    fingerstick, temperature, tod, rand, clamp, insulinActivity,
  };
})();
