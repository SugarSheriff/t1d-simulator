// Simplified type 1 diabetes physiology model: Omnipod 5 (Automated Mode) + Dexcom G7.
// Educational only. This is NOT a medical model and must never be used for dosing decisions.
(function () {
  const T1D = (window.T1D = window.T1D || {});

  const PROFILE = {
    isf: 40, // mg/dL drop from 1 unit of rapid insulin
    target: 110,
    activityTarget: 150, // Omnipod 5 Activity feature
    basalPerDay: 20, // what the pod's basal program delivers in a day
    // Carb ratio (grams per unit) changes through the day. Mornings usually need more insulin.
    ratios: [
      { from: 0, ratio: 10, label: "overnight" },
      { from: 5 * 60, ratio: 8, label: "morning" },
      { from: 11 * 60, ratio: 10, label: "afternoon" },
      { from: 17 * 60, ratio: 11, label: "evening" },
    ],
  };
  const BASE_RATE = PROFILE.basalPerDay / 1440; // u/min of programmed basal
  const BASE_EGP = PROFILE.basalPerDay * PROFILE.isf / 1440; // liver output that basal is meant to cancel
  const POD_EXPIRES = 72 * 60;
  const POD_SHUTOFF = 80 * 60; // 8-hour grace period, then it stops for good
  const G7_LIFE = 10 * 1440 + 12 * 60; // 10 days + 12-hour grace period
  const G7_WARMUP = 30;

  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const gauss = () => Math.sqrt(-2 * Math.log(1 - Math.random())) * Math.cos(2 * Math.PI * Math.random());
  const tod = (t) => ((t % 1440) + 1440) % 1440;
  const rand = (a, b) => a + Math.random() * (b - a);
  const randInt = (a, b) => Math.floor(rand(a, b + 1));

  function ratioAt(t) {
    const m = tod(t);
    let r = PROFILE.ratios[0];
    for (const s of PROFILE.ratios) if (m >= s.from) r = s;
    return r;
  }

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
    coffee: {
      name: "Black coffee", duration: 30, delay: 0, error: 0, caffeine: true,
      note: "Zero carbs, but caffeine pushes some people up anyway.",
      parts: [{ item: "Black coffee", per: "1 cup", carbs: 0, qty: [1, 2], caffeine: true }],
    },
    latte: {
      name: "Latte", duration: 50, delay: 5, error: 0.08, caffeine: true,
      parts: [
        { item: "Milk", per: "1 cup", carbs: 12, qty: [1, 1.5] },
        { item: "Vanilla syrup", per: "1 pump", carbs: 5, qty: [0, 2, 3, 4] },
        { item: "Espresso", per: "1 shot", carbs: 0, qty: [2], caffeine: true },
      ],
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
    beer: {
      name: "Beer", duration: 60, delay: 5, error: 0.05,
      note: "Alcohol stops your liver from releasing sugar for hours. The low comes later, often overnight.",
      parts: [{ item: "Beer", per: "12 oz can", carbs: 13, qty: [1, 2], alcohol: true }],
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
  T1D.MENU = ["tabs", "juice", "coffee", "latte", "apple", "granola", "cereal", "eggs", "sandwich", "salad", "pasta", "pizza", "beer"];

  // Rolls how much you're actually eating this time and what the carbs really are.
  function serving(id) {
    const f = FOODS[id];
    const rows = [];
    let alcohol = 0;
    let caffeine = 0;
    for (const p of f.parts) {
      const qty = p.qty[Math.floor(Math.random() * p.qty.length)];
      if (qty <= 0) continue;
      rows.push({ item: p.item, per: p.per, carbs: p.carbs, qty });
      if (p.alcohol) alcohol += qty;
      if (p.caffeine) caffeine += qty;
    }
    const answer = Math.round(rows.reduce((s, r) => s + r.carbs * r.qty, 0));
    const actual = Math.max(0, Math.round(answer * (1 + gauss() * f.error * 0.6)));
    return { id, food: f, rows, answer, actual, alcohol, caffeine };
  }

  // Afternoon heat. Peaks around 4pm.
  function temperature(t) {
    const h = tod(t) / 60;
    const x = Math.cos(((h - 16) / 24) * 2 * Math.PI);
    return Math.round(76 + 20 * x);
  }

  function newPod(S, opts = {}) {
    S.pod = {
      attached: true,
      age: opts.age || 0,
      reservoir: opts.reservoir || 180,
      mode: "automated",
      activityUntil: 0,
      occluded: false,
      missed: 0,
      failed: false,
      siteFactor: opts.siteFactor || 1, // scar tissue soaks up less insulin
      insulinPotency: opts.insulinPotency || 1, // old or heat-damaged insulin
      lastFactor: 1,
    };
  }

  function createState(t0) {
    const S = {
      t: t0,
      dayStart: t0,
      day: 1,
      bg: rand(115, 140),
      insulin: [], // everything the pod delivered: {t, units, potency, kind, base}
      carbs: [],
      drift: 0,
      stress: 0,
      hiddenRise: 0,
      caffeine: 0,
      alcohol: 0,
      illness: 0,
      cycle: 0,
      hydration: 85,
      exerciseBoost: 0,
      sleepDebt: 0,
      ketones: 0.2,
      consciousness: 100,
      lowTolerance: rand(0.7, 1.4), // some people pass out in the 50s, some function in the 40s
      lowTimes: [], // recent severe lows blunt your warning symptoms (hypo unawareness)
      severeLow: false,
      lowHangoverUntil: 0,
      activity: "sit",
      activityStart: t0,
      location: "home",
      heatResponse: null,
      forced: null,
      dead: null,
      supplies: { pods: randInt(1, 4), sensors: randInt(0, 2), vials: randInt(0, 1), vialAgeDays: randInt(8, 31) },
      cgm: {
        status: "ok", value: null, trend: 0, nextAt: t0, lastValueAt: t0,
        warmupUntil: 0, errorUntil: 0, errorFails: false, compressionUntil: 0, signalLostUntil: 0,
        sensorAge: randInt(1, 9) * 1440 + randInt(0, 1439),
      },
      lastFinger: null,
      history: [],
      readings: [],
      markers: [],
      notes: [],
    };
    newPod(S, { age: randInt(4, 66) * 60, reservoir: randInt(40, 150) });
    // The pod has been running for hours already: fill in its basal so insulin on board is steady.
    for (let t = t0 - 300; t < t0; t += 5) {
      S.insulin.push({ t, units: BASE_RATE * 5, potency: 1, kind: "auto", base: BASE_RATE * 5 });
    }
    return S;
  }

  // ---------- insulin ----------
  function podWorking(p) {
    return p.attached && !p.failed && p.age < POD_SHUTOFF;
  }

  // The pod pushes insulin. Whether it reaches you is another question.
  function deliver(S, units, kind) {
    const p = S.pod;
    if (!podWorking(p) || units <= 0) return 0;
    const given = Math.min(units, p.reservoir);
    p.reservoir = Math.max(0, p.reservoir - given);
    if (p.occluded) {
      p.missed += given;
      return given; // the pod thinks it delivered it
    }
    S.insulin.push({
      t: S.t, units: given, potency: p.siteFactor * p.insulinPotency, kind,
      base: kind === "auto" ? BASE_RATE * 5 : 0,
    });
    return given;
  }

  function totalIOB(S) {
    // What the Omnipod 5 app shows: boluses + automated delivery above your programmed basal.
    let sum = 0;
    for (const d of S.insulin) sum += (d.units - d.base) * RAPID.iob(S.t - d.t);
    return Math.max(0, sum);
  }

  function cgmUsable(S) {
    const c = S.cgm;
    return c.status === "ok" && c.value != null && S.t - c.lastValueAt <= 15;
  }

  // Omnipod 5 Automated Mode, simplified: every 5 minutes it predicts where you'll be in 30 minutes
  // and delivers more or less than your programmed basal.
  function podTick(S) {
    const p = S.pod;
    if (!podWorking(p)) return;
    const activity = S.t < p.activityUntil;
    let factor = 1;
    if (S.cgm.status === "ok" && S.cgm.value != null && S.t - S.cgm.lastValueAt <= 20) {
      p.mode = "automated";
      const target = activity ? PROFILE.activityTarget : PROFILE.target;
      const pred = S.cgm.value + S.cgm.trend * 30 - totalIOB(S) * PROFILE.isf * 0.5;
      factor = clamp(1 + (pred - target) / 60, 0, 2.5);
      if (pred < target - 30) factor = 0;
      if (activity) factor = Math.min(factor, 1) * 0.6;
    } else {
      // No CGM data: Limited Mode. It can't respond, so it just runs basal.
      p.mode = "limited";
      factor = activity ? 0.6 : 1;
    }
    p.lastFactor = factor;
    deliver(S, BASE_RATE * 5 * factor, "auto");
  }

  function podSuggestion(S, carbs, bg) {
    const r = ratioAt(S.t);
    const target = S.t < S.pod.activityUntil ? PROFILE.activityTarget : PROFILE.target;
    const iob = totalIOB(S);
    const meal = carbs / r.ratio;
    let corr = 0;
    if (bg != null) {
      corr = (bg - target) / PROFILE.isf;
      // Insulin on board only cancels out the correction, not the meal.
      if (corr > 0) corr = Math.max(0, corr - iob);
      // Below target, a "reverse correction" shrinks the meal dose.
    }
    const total = Math.max(0, Math.round((meal + corr) * 20) / 20); // pods dose in 0.05 u steps
    return { ratio: r.ratio, period: r.label, target, iob, meal, corr, total };
  }

  // ---------- the body, one minute at a time ----------
  function step(S) {
    const t = S.t;
    const h = tod(t) / 60;
    const hot = S.activity === "outside" && temperature(t) >= 85;
    const mins = t - S.activityStart;

    // Things that push glucose up.
    let hormone = 1;
    if (h >= 4 && h < 9) hormone += 0.3; // dawn phenomenon
    hormone += S.stress * 0.7 + S.hiddenRise + S.caffeine * 0.12 + S.illness * 0.4;
    if (S.hydration < 40) hormone += 0.25;
    // Alcohol makes the liver stop releasing sugar.
    const egp = BASE_EGP * hormone * (1 - Math.min(0.45, S.alcohol * 0.18));

    // How hard insulin hits right now.
    let sens = 1 + S.exerciseBoost;
    if (h >= 5 && h < 11) sens *= 0.8; // mornings are more insulin resistant
    else if (h >= 17) sens *= 1.1;
    sens *= 1 - Math.min(0.3, S.stress * 0.25);
    sens *= 1 - Math.min(0.2, S.sleepDebt * 0.2);
    sens *= 1 - S.illness * 0.25 - S.cycle * 0.2;
    if (hot && S.heatResponse === "absorb") sens *= 1.4; // heat speeds insulin absorption
    if (S.ketones > 1.5) sens *= 0.8;

    let insulinAct = 0;
    for (const d of S.insulin) insulinAct += d.units * d.potency * RAPID.activity(t - d.t);
    const insulinDrop = insulinAct * PROFILE.isf * sens;

    let carbRise = 0;
    for (const c of S.carbs) carbRise += c.grams * carbRate(t - c.t, c) * (PROFILE.isf / 10);

    let muscle = 0;
    if (S.activity === "walk") muscle = 0.35;
    if (S.activity === "cardio") muscle = mins < 5 ? 0.3 : 1.1;
    if (S.activity === "lift") muscle = -0.5; // lifting dumps adrenaline: usually goes UP
    if (hot && S.heatResponse === "stress") muscle -= 0.4;

    S.drift = S.drift * 0.97 + gauss() * 0.02; // the "no reason at all" factor
    const kidneys = S.bg > 180 ? (S.bg - 180) * 0.002 : 0;

    S.bg = clamp(S.bg + egp - insulinDrop + carbRise - muscle + S.drift - kidneys, 15, 600);

    // Slow-moving body state.
    S.stress = Math.max(0, S.stress - 0.004);
    S.hiddenRise = Math.max(0, S.hiddenRise - 0.002);
    S.caffeine *= 0.9977; // ~5 hour half-life
    S.alcohol *= 0.997; // effect lingers for hours
    if (S.activity === "walk" && mins > 20) S.exerciseBoost = Math.max(S.exerciseBoost, 0.2);
    else if (S.activity === "cardio" && mins > 20) S.exerciseBoost = Math.max(S.exerciseBoost, 0.5);
    else if (S.activity === "lift" && mins > 20) S.exerciseBoost = Math.max(S.exerciseBoost, 0.3); // delayed drop later
    else S.exerciseBoost *= 0.997;

    let thirst = 0.03;
    if (hot) thirst = 0.25;
    else if (S.activity === "cardio" || S.activity === "lift") thirst = 0.15;
    if (S.bg > 220) thirst += 0.04;
    S.hydration = clamp(S.hydration - thirst, 0, 100);

    // Without insulin your body burns fat and makes ketones. On a pump there's no long-acting backup.
    if (insulinAct < 0.006) S.ketones += 0.008;
    else if (S.bg > 250) S.ketones += 0.0015;
    else S.ketones -= 0.003;
    S.ketones = clamp(S.ketones, 0.1, 8);

    // Severe lows drain you until you pass out. How fast depends on the person.
    if (S.bg < 54) S.consciousness -= (54 - S.bg) * 0.12 * S.lowTolerance;
    else if (S.bg > 70) S.consciousness = Math.min(100, S.consciousness + 1);
    if (S.bg < 55) S.severeLow = true;
    if (S.severeLow && S.bg > 80) {
      S.severeLow = false;
      S.lowHangoverUntil = t + 180;
      S.lowTimes.push(t);
    }
    S.lowTimes = S.lowTimes.filter((x) => t - x < 1440);
    if (S.consciousness <= 0) S.dead = "low";
    if (S.ketones >= 3.5 && S.bg > 250) S.dead = "dka";

    // Pod.
    S.pod.age++;
    if (t % 5 === 0) podTick(S);

    S.history.push({ t, bg: S.bg });
    if (S.history.length > 3000) S.history.shift();
    S.insulin = S.insulin.filter((d) => t - d.t < 300);
    S.carbs = S.carbs.filter((c) => t - c.t < c.delay + c.duration);

    S.cgm.sensorAge++;
    S.t++;
  }

  function bgAt(S, t) {
    for (let i = S.history.length - 1; i >= 0; i--) if (S.history[i].t <= t) return S.history[i].bg;
    return S.history.length ? S.history[0].bg : S.bg;
  }

  // Dexcom G7: reads every 5 min, ~10 min behind your blood, a little noisy, and sometimes just wrong.
  function updateCGM(S) {
    const c = S.cgm;
    if (S.t < c.nextAt) return false;
    c.nextAt = S.t + 5;
    if (c.status === "ok" && c.sensorAge >= G7_LIFE) c.status = "expired";
    if (c.status === "warmup" && S.t >= c.warmupUntil) c.status = "ok";
    if (c.status === "error" && S.t >= c.errorUntil) c.status = c.errorFails ? "failed" : "ok";
    const lost = S.t < c.signalLostUntil;
    if (c.status !== "ok" || lost) {
      c.value = null;
      c.trend = 0;
      S.readings.push({ t: S.t, v: null });
      return true;
    }
    let v = bgAt(S, S.t - 10) * (1 + gauss() * 0.035);
    if (S.t < c.compressionUntil) v -= 40; // lying on the sensor
    v = Math.round(clamp(v, 39, 401)); // G7 reads 40–400
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
    c.lastValueAt = S.t;
    S.readings.push({ t: S.t, v });
    if (S.readings.length > 700) S.readings.shift();
    return true;
  }

  function newSensor(S) {
    const c = S.cgm;
    c.status = "warmup";
    c.warmupUntil = S.t + G7_WARMUP;
    c.sensorAge = 0;
    c.compressionUntil = 0;
    c.signalLostUntil = 0;
  }

  function cobEstimate(S) {
    return S.carbs.reduce((sum, c) => sum + c.labeled * (1 - carbAbsorbed(S.t - c.t, c)), 0);
  }

  // `counted` is what the player worked out. The body only cares about `actual`.
  function eat(S, serv, counted, inMinutes = 0) {
    const f = serv.food;
    const c = { t: S.t + inMinutes, grams: serv.actual, labeled: counted, duration: f.duration, delay: f.delay, name: f.name, serv };
    S.carbs.push(c);
    S.markers.push({ t: c.t, type: "carb", label: f.name });
    return c;
  }
  function bolus(S, units) {
    const given = deliver(S, units, "bolus");
    if (given > 0) S.markers.push({ t: S.t, type: "insulin", label: (Math.round(given * 100) / 100) + "u" });
    return given;
  }
  // Meters are allowed to be off by up to ±15%. Nothing is ground truth.
  function fingerstick(S) {
    const v = Math.round(S.bg * (1 + clamp(gauss() * 0.06, -0.15, 0.15)));
    S.lastFinger = { t: S.t, v };
    S.markers.push({ t: S.t, type: "finger", v });
    return v;
  }

  T1D.model = {
    PROFILE, FOODS, RAPID, POD_EXPIRES, POD_SHUTOFF, G7_LIFE, G7_WARMUP,
    createState, step, updateCGM, newSensor, newPod, podWorking, podSuggestion, totalIOB, cgmUsable,
    ratioAt, cobEstimate, serving, eat, bolus, fingerstick, temperature, tod, rand, randInt, clamp,
  };
})();
