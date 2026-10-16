(function () {
  const M = T1D.model;
  const E = T1D.events;
  const P = M.PROFILE;
  const $ = (s) => document.querySelector(s);
  const START = 6 * 60 + 45;
  const SLEEP_SPEED = 15;

  let S;
  let speed = 0;
  let acc = 0;
  let lastFrame = performance.now();
  let doseUnits = 0;
  let sound = true;
  let audio = null;
  const modalQueue = [];
  let modalOpen = false;

  const logEl = $("#log");

  function fmt(t) {
    const m = M.tod(t);
    let h = Math.floor(m / 60);
    const ap = h >= 12 ? "PM" : "AM";
    h = h % 12 || 12;
    return `${h}:${String(m % 60).padStart(2, "0")} ${ap}`;
  }

  function newStats() {
    return { minutes: 0, inRange: 0, sum: 0, lows: 0, highs: 0, decisions: 0, alarms: 0, wakeups: 0, inLow: false, inHigh: false, min: 999, max: 0, mathTotal: 0, mathRight: 0, doseOff: 0 };
  }

  function reset() {
    S = M.createState(START);
    S.stats = newStats();
    S.fired = new Set();
    S.counts = {};
    S.alarm = { low: -999, high: -999 };
    S.symptomNoted = false;
    S.heatNoted = false;
    // Fake the last few hours so the graph isn't empty.
    for (let t = START - 240; t < START; t++) {
      const bg = S.bg - (START - t) * 0.08 + Math.sin(t / 37) * 4;
      S.history.push({ t, bg });
      if (t % 5 === 0) S.readings.push({ t, v: Math.round(bg) });
    }
    S.cgm.value = S.readings[S.readings.length - 1].v;
    logEl.innerHTML = "";
    doseUnits = 0;
    acc = 0;
  }

  // ---------- log + modal ----------
  function log(text, kind = "info") {
    const li = document.createElement("li");
    li.className = kind;
    li.innerHTML = `<time>${fmt(S.t)}</time><span></span>`;
    li.querySelector("span").textContent = text;
    logEl.prepend(li);
    while (logEl.children.length > 120) logEl.lastChild.remove();
  }

  function modal(opts) {
    modalQueue.push(opts);
    if (!modalOpen) nextModal();
  }
  function nextModal() {
    const opts = modalQueue.shift();
    const el = $("#modal");
    if (!opts) {
      el.hidden = true;
      modalOpen = false;
      render();
      return;
    }
    modalOpen = true;
    el.hidden = false;
    el.className = "modal " + (opts.tone || "");
    $("#modal-title").textContent = opts.title;
    const body = $("#modal-body");
    body.innerHTML = "";
    if (opts.html) body.innerHTML = opts.html;
    else if (opts.node) body.appendChild(opts.node);
    else {
      const p = document.createElement("p");
      p.textContent = opts.body || "";
      body.appendChild(p);
    }
    const actions = $("#modal-actions");
    actions.innerHTML = "";
    opts.choices.forEach((c, i) => {
      const b = document.createElement("button");
      b.textContent = c.label;
      b.className = i === 0 ? "primary" : "";
      b.onclick = () => {
        if (!opts.noDecision) S.stats.decisions++;
        const keepOpen = c.run && c.run() === false;
        if (!keepOpen) nextModal();
      };
      actions.appendChild(b);
    });
    actions.querySelector("button")?.focus();
  }

  // ---------- actions ----------
  function setActivity(act) {
    if (S.activity === act) return;
    const wasSleeping = S.activity === "sleep";
    S.activity = act;
    S.activityStart = S.t;
    if (act === "outside") {
      S.heatResponse = Math.random() < 0.6 ? "absorb" : "stress";
      const temp = M.temperature(S.t);
      if (temp >= 85 && !S.heatNoted) {
        S.heatNoted = true;
        log(`It's ${temp}°F. Heat can make insulin absorb faster and drop you, or stress hormones can push you up. You won't know which until it happens.`, "info");
      }
    }
    if (act === "sleep") {
      setSpeed(SLEEP_SPEED);
    } else if (wasSleeping) {
      setSpeed(1);
    }
  }

  function force(act, minutes, reason, onEnd) {
    setActivity(act);
    S.forced = { activity: act, until: S.t + minutes, reason, onEnd };
  }

  // Nothing goes in your mouth without math: count the carbs, then work out the dose yourself.
  function eat(id) {
    const serv = M.serving(id);
    const f = serv.food;
    const r = latestReading();
    const iob = M.iob(S);
    const qty = (q) => (q === 0.5 ? "½" : q === 0.75 ? "¾" : q === 1.25 ? "1¼" : q === 1.5 ? "1½" : String(q));
    const wrap = document.createElement("div");
    wrap.className = "count";
    wrap.innerHTML = `
      ${f.note ? `<p class="hint">${f.note}</p>` : ""}
      <table>
        <thead><tr><th>Item</th><th>Carbs per serving</th><th>You're having</th></tr></thead>
        <tbody>${serv.rows
          .map((row) => `<tr><td>${row.item}</td><td>${row.carbs} g per ${row.per}</td><td>${qty(row.qty)} × (${row.per})</td></tr>`)
          .join("")}</tbody>
      </table>
      <div class="count-inputs">
        <label>Total carbs (g)<input id="count-carbs" type="number" min="0" max="400" step="1" inputmode="numeric"></label>
        <label>Rapid insulin (units)<input id="count-units" type="number" min="0" max="25" step="0.5" inputmode="decimal"></label>
      </div>
      <dl>
        <dt>Latest glucose</dt><dd>${r ? `${r.v} mg/dL (${r.src})` : "No recent reading. You're guessing."}</dd>
        <dt>Insulin on board</dt><dd>${iob.toFixed(1)} u</dd>
        <dt>Your numbers</dt><dd>1 u per ${P.carbRatio} g carbs · 1 u drops ~${P.isf} mg/dL · target ${P.target}</dd>
      </dl>
      <p class="hint">Dose = carbs ÷ ${P.carbRatio} + (glucose − ${P.target}) ÷ ${P.isf} − insulin on board. Round to the nearest 0.5.
      Treating a low? You usually take 0.</p>
      <p class="count-error" role="alert"></p>`;

    modal({
      title: `Count it: ${f.name}`,
      node: wrap,
      choices: [
        {
          label: "Eat it",
          run() {
            const carbsIn = wrap.querySelector("#count-carbs").value.trim();
            const unitsIn = wrap.querySelector("#count-units").value.trim();
            const err = wrap.querySelector(".count-error");
            if (carbsIn === "" || isNaN(Number(carbsIn))) {
              err.textContent = "Add up the carbs first. Nobody's going to do it for you.";
              return false;
            }
            if (unitsIn === "" || isNaN(Number(unitsIn))) {
              err.textContent = "Decide on a dose. Enter 0 if you're not taking any.";
              return false;
            }
            const counted = Math.max(0, Math.round(Number(carbsIn)));
            const units = Math.max(0, Math.round(Number(unitsIn) * 2) / 2);
            finishEating(serv, counted, units, r, iob);
          },
        },
        { label: "Never mind", run: () => log(`You decide not to have the ${f.name.toLowerCase()}.`, "info") },
      ],
    });
    setTimeout(() => wrap.querySelector("#count-carbs")?.focus(), 0);
  }

  function finishEating(serv, counted, units, reading, iob) {
    const f = serv.food;
    const st = S.stats;
    M.eat(S, serv, counted);
    if (units > 0) M.bolus(S, units);
    log(`You eat: ${f.name}. You counted ${counted} g${units > 0 ? ` and took ${units} u` : " and took no insulin"}.`, "food");

    st.mathTotal++;
    if (Math.abs(counted - serv.answer) <= Math.max(2, serv.answer * 0.05)) {
      st.mathRight++;
      log("Your carb math checks out.", "good");
    } else {
      log(`Check your math: those numbers add up to ${serv.answer} g, not ${counted} g.`, "warn");
    }

    const correction = reading ? (reading.v - P.target) / P.isf : 0;
    const ideal = Math.max(0, Math.round((serv.answer / P.carbRatio + correction - iob) * 2) / 2);
    if (Math.abs(units - ideal) >= 1) {
      st.doseOff++;
      S.notes.push(`${fmt(S.t)}: ${f.name.toLowerCase()}: the dose math said about ${ideal} u, you took ${units} u.`);
    }
    if (Math.abs(serv.actual - serv.answer) >= 8) {
      S.notes.push(`${fmt(S.t)}: the ${f.name.toLowerCase()} was really ${serv.actual} g of carbs. The math said ${serv.answer} g. You can do it right and still be wrong.`);
    }
    if (f.fast) log("Rule of 15: wait 15 minutes, then check again. It's tempting to keep eating. Don't.", "info");
    render();
  }

  function fingerstick() {
    S.stats.decisions++;
    return M.fingerstick(S);
  }

  const api = {
    get S() {
      return S;
    },
    log, modal, force, eat, fmt,
    fingerstick,
  };

  // ---------- alarms ----------
  function beep(urgent) {
    if (!sound || !audio) return;
    const n = urgent ? 3 : 2;
    for (let i = 0; i < n; i++) {
      const o = audio.createOscillator();
      const g = audio.createGain();
      o.frequency.value = urgent ? 880 : 660;
      g.gain.value = 0.06;
      o.connect(g).connect(audio.destination);
      const start = audio.currentTime + i * 0.22;
      o.start(start);
      o.stop(start + 0.14);
    }
  }

  function alarm(kind, v, urgent) {
    S.stats.alarms++;
    beep(urgent);
    log(`CGM alarm: ${kind} ${v} ${arrow(S.cgm.trend)}`, urgent ? "bad" : "warn");
    if (S.activity === "sleep") wakeUp(`Your CGM alarm woke you up: ${kind.toUpperCase()} ${v} ${arrow(S.cgm.trend)}`, v < 100);
  }

  function wakeUp(message, low) {
    S.stats.wakeups++;
    S.sleepDebt = Math.min(1, S.sleepDebt + 0.08);
    const choices = [];
    if (low) choices.push({ label: "Eat glucose tabs, back to sleep", run: () => eat("tabs") });
    choices.push(
      {
        label: "Fingerstick to see if it's real",
        run() {
          const v = fingerstick();
          log(`Fingerstick at night: ${v} mg/dL.`, v < 70 || v > 250 ? "warn" : "info");
          setActivity("sit");
          log("You're up now. Deal with it, then go back to sleep.", "info");
        },
      },
      { label: "Get up and deal with it", run: () => setActivity("sit") },
      { label: "Ignore it, back to sleep", run: () => log("You silence the alarm and roll over.", "info") }
    );
    modal({ title: "3 AM, probably", body: message, tone: "night", choices });
  }

  function checkAlarms() {
    const v = S.cgm.value;
    if (v == null) return;
    if (v < 55 && S.t - S.alarm.low >= 10) {
      S.alarm.low = S.t;
      alarm("Urgent low", v, true);
    } else if (v < 70 && S.t - S.alarm.low >= 20) {
      S.alarm.low = S.t;
      alarm("Low", v, false);
    }
    if (v > 250 && S.t - S.alarm.high >= 60) {
      S.alarm.high = S.t;
      alarm("High", v, false);
    }
  }

  // ---------- the clock ----------
  function tick() {
    if (S.t - S.dayStart >= 1440) {
      endDay();
      return false;
    }
    const m = M.tod(S.t);
    for (const e of E.scheduled) {
      if (e.at === m && !S.fired.has(e.at)) {
        S.fired.add(e.at);
        e.run(api);
      }
    }
    for (const ev of E.random) {
      if ((S.counts[ev.id] || 0) < ev.max && ev.when(S) && Math.random() < ev.chance / 60) {
        S.counts[ev.id] = (S.counts[ev.id] || 0) + 1;
        ev.run(api);
      }
    }
    if (S.forced && S.t >= S.forced.until) {
      const f = S.forced;
      S.forced = null;
      setActivity("sit");
      f.onEnd && f.onEnd();
    }

    M.step(S);
    const st = S.stats;
    st.minutes++;
    st.sum += S.bg;
    st.min = Math.min(st.min, S.bg);
    st.max = Math.max(st.max, S.bg);
    if (S.bg >= 70 && S.bg <= 180) st.inRange++;
    if (S.bg < 70 && !st.inLow) {
      st.inLow = true;
      st.lows++;
    } else if (S.bg >= 80) st.inLow = false;
    if (S.bg > 250 && !st.inHigh) {
      st.inHigh = true;
      st.highs++;
    } else if (S.bg <= 230) st.inHigh = false;

    if (M.updateCGM(S)) checkAlarms();

    // Your body warns you too, sometimes.
    if (S.bg < 65 && !S.symptomNoted && S.activity !== "sleep") {
      S.symptomNoted = true;
      log("You feel shaky, sweaty, and suddenly starving. That usually means you're low.", "warn");
    } else if (S.bg > 85) S.symptomNoted = false;
    if (S.activity === "sleep" && S.bg < 55 && S.cgm.status !== "ok" && Math.random() < 0.03) {
      wakeUp("You wake up drenched in sweat, heart pounding. No CGM to tell you how bad it is.", true);
    }
    if (S.activity === "driving" && S.bg < 70 && !S.driveLowWarned) {
      S.driveLowWarned = true;
      modal({
        title: "You're low behind the wheel",
        tone: "danger",
        body: "Your hands are shaking and the road looks wrong. You should pull over, treat it, and wait at least 15 minutes before driving again.",
        choices: [
          {
            label: "Pull over, eat glucose tabs, wait",
            run() {
              eat("tabs");
              if (S.forced) S.forced.until += 20;
              S.stress = Math.min(1, S.stress + 0.3);
              log("You're going to be late. You text an excuse.", "info");
            },
          },
          {
            label: "Keep driving, you're almost there",
            run() {
              S.stress = Math.min(1, S.stress + 0.2);
              S.notes.push(`${fmt(S.t)}: you kept driving while low. This is how crashes happen.`);
              log("You white-knuckle it the rest of the way.", "bad");
            },
          },
        ],
      });
    }

    if (S.activity === "sleep") S.sleepDebt = Math.max(0, S.sleepDebt - 1 / 500);
    else if (m < START || m >= 23 * 60 + 30) S.sleepDebt = Math.min(1, S.sleepDebt + 1 / 400);

    if (S.dead) {
      gameOver();
      return false;
    }
    return true;
  }

  // A timer, not requestAnimationFrame: diabetes doesn't pause when you switch tabs.
  function frame() {
    const now = performance.now();
    const dt = Math.min(1100, now - lastFrame);
    lastFrame = now;
    if (speed > 0 && !modalOpen) {
      acc += (dt * speed) / 1000;
      let n = 0;
      while (acc >= 1 && n < 120) {
        acc -= 1;
        n++;
        if (!tick() || modalOpen) {
          acc = 0;
          break;
        }
      }
      if (n) render();
    }
  }

  function setSpeed(v) {
    speed = v;
    document.querySelectorAll("[data-speed]").forEach((b) => b.classList.toggle("on", Number(b.dataset.speed) === v));
  }

  // ---------- end states ----------
  function endDay() {
    if (S.activity === "sleep") setActivity("sit");
    S.location = "home";
    setSpeed(0);
    const st = S.stats;
    const tir = Math.round((st.inRange / Math.max(1, st.minutes)) * 100);
    const avg = Math.round(st.sum / Math.max(1, st.minutes));
    const notes = S.notes.length
      ? `<h3>Things you didn't see</h3><ul>${S.notes.map((n) => `<li>${n}</li>`).join("")}</ul>`
      : "";
    modal({
      title: `You survived day ${S.day}`,
      noDecision: true,
      html: `
        <div class="summary">
          <div><b>${tir}%</b><span>time in range (70–180)</span></div>
          <div><b>${avg}</b><span>average mg/dL</span></div>
          <div><b>${st.lows}</b><span>lows</span></div>
          <div><b>${st.highs}</b><span>highs over 250</span></div>
          <div><b>${st.decisions}</b><span>decisions you made</span></div>
          <div><b>${st.mathRight}/${st.mathTotal}</b><span>carb counts right</span></div>
          <div><b>${st.doseOff}</b><span>doses off by 1u+</span></div>
          <div><b>${st.alarms}</b><span>CGM alarms</span></div>
          <div><b>${st.wakeups}</b><span>times woken up at night</span></div>
          <div><b>${Math.round(st.min)}–${Math.round(st.max)}</b><span>lowest–highest</span></div>
        </div>
        ${notes}
        <p class="closing">That was one day. Tomorrow you do it again, and the day after that.
        No weekends, no vacations, no sick days. People with type 1 are often said to make an extra
        ~180 health decisions a day, and all of it happens on top of a full-time job.</p>`,
      choices: [
        {
          label: "Live another day",
          run() {
            S.day++;
            S.dayStart += 1440;
            S.stats = newStats();
            S.fired = new Set();
            S.counts = {};
            S.notes = [];
            S.potency = 1;
            setSpeed(1);
          },
        },
        { label: "Start over", run: () => start() },
      ],
    });
  }

  function gameOver() {
    setSpeed(0);
    const low = S.dead === "low";
    modal({
      title: low ? "Severe hypoglycemia" : "Diabetic ketoacidosis (DKA)",
      tone: "danger",
      noDecision: true,
      body: low
        ? "Your blood sugar dropped too low and you lost consciousness. In real life this is an emergency: someone has to give you glucagon or call 911. It can happen at your desk, behind the wheel, or in your sleep."
        : "Without enough insulin, your body started burning fat for fuel and your blood turned acidic. Nausea, vomiting, confusion. In real life you'd be in the ER, maybe the ICU, on an IV insulin drip. Missing a long-acting dose can start this.",
      choices: [{ label: "Try again", run: () => start() }],
    });
  }

  // ---------- rendering ----------
  function arrow(trend) {
    if (trend > 2) return "⇈";
    if (trend > 1) return "↑";
    if (trend > 0.5) return "↗";
    if (trend < -2) return "⇊";
    if (trend < -1) return "↓";
    if (trend < -0.5) return "↘";
    return "→";
  }
  function rangeClass(v) {
    if (v == null) return "";
    if (v < 55) return "urgent";
    if (v < 70) return "low";
    if (v > 250) return "veryhigh";
    if (v > 180) return "high";
    return "ok";
  }
  function feel() {
    const b = S.bg;
    if (S.ketones > 1.5) return "Nauseous, stomach pain";
    if (b < 54) return "Confused, vision blurring";
    if (b < 70) return "Shaky, sweaty, starving";
    if (b > 300) return "Exhausted, nauseous";
    if (b > 250) return "Thirsty, headache, foggy";
    if (b > 180) return "A bit sluggish";
    if (S.hydration < 40) return "Dehydrated";
    if (S.sleepDebt > 0.5) return "Running on no sleep";
    return "Okay";
  }
  const ACT_LABEL = { sit: null, walk: "Walking", outside: "Outside", gym: "Working out", sleep: "Asleep", driving: "Driving", meeting: "In a meeting" };
  function where() {
    if (S.forced) return S.forced.reason;
    const base = ACT_LABEL[S.activity] || (S.location === "work" ? "At your desk" : "On the couch");
    if (S.activity === "outside") return `${base} · ${M.temperature(S.t)}°F`;
    return base;
  }
  function latestReading() {
    if (S.cgm.status === "ok" && S.cgm.value != null) return { v: S.cgm.value, src: "CGM" };
    if (S.lastFinger && S.t - S.lastFinger.t <= 30) return { v: S.lastFinger.v, src: "fingerstick" };
    return null;
  }

  function render() {
    $("#time").textContent = fmt(S.t);
    $("#day").textContent = `Day ${S.day}`;

    const c = S.cgm;
    const val = $("#cgm-value");
    let status;
    if (c.status === "ok" && c.value != null) {
      val.textContent = c.value <= 39 ? "LO" : c.value >= 401 ? "HI" : c.value;
      val.className = "cgm-value " + rangeClass(c.value);
      $("#cgm-arrow").textContent = arrow(c.trend);
      status = "CGM · live";
    } else {
      val.textContent = "---";
      val.className = "cgm-value off";
      $("#cgm-arrow").textContent = "";
      if (c.status === "warmup") {
        const left = c.warmupUntil - S.t;
        status = `Sensor warm-up · ${Math.floor(left / 60)}h ${left % 60}m left`;
      } else if (c.status === "error") status = "Sensor error · no readings";
      else if (c.status === "failed") status = "Sensor failed · replace it";
      else status = "No sensor · put on a new one";
    }
    $("#cgm-status").textContent = status;

    const fs = S.lastFinger && S.t - S.lastFinger.t <= 60 ? `${S.lastFinger.v} (${S.t - S.lastFinger.t} min ago)` : "—";
    $("#finger").textContent = fs;
    $("#iob").textContent = M.iob(S).toFixed(1) + " u";
    $("#cob").textContent = Math.round(M.cobEstimate(S)) + " g";
    $("#feel").textContent = feel();
    $("#where").textContent = where();

    setMeter("hydration", S.hydration);
    setMeter("rest", (1 - S.sleepDebt) * 100);
    setMeter("stress", S.stress * 100, true);

    const st = S.stats;
    $("#tir").textContent = st.minutes ? Math.round((st.inRange / st.minutes) * 100) + "%" : "—";
    $("#decisions").textContent = st.decisions;
    $("#alarms").textContent = st.alarms;
    $("#lows").textContent = st.lows;

    $("#dose").textContent = doseUnits.toFixed(1);
    document.body.classList.toggle("sym-low", S.bg < 70 && S.bg >= 54);
    document.body.classList.toggle("sym-severe", S.bg < 54);
    document.body.classList.toggle("sym-high", S.bg > 250);
    document.body.classList.toggle("asleep", S.activity === "sleep");

    const locked = !!S.forced;
    document.querySelectorAll("[data-act]").forEach((b) => {
      const a = b.dataset.act;
      let disabled = locked;
      if (a === "gym" && S.location === "work") disabled = true;
      if (a === "sleep" && S.location === "work") disabled = true;
      b.disabled = disabled;
      b.classList.toggle("on", S.activity === a);
      if (a === "sit") b.textContent = S.location === "work" ? "Desk" : "Couch";
    });
    $("#lock-note").textContent = locked ? `${S.forced.reason}, can't change what you're doing right now.` : "";

    drawGraph();
  }

  function setMeter(id, pct, inverse) {
    const el = $(`#m-${id}`);
    el.style.width = Math.max(0, Math.min(100, pct)) + "%";
    const bad = inverse ? pct > 55 : pct < 40;
    el.classList.toggle("bad", bad);
  }

  function drawGraph() {
    const cv = $("#graph");
    const dpr = window.devicePixelRatio || 1;
    const W = cv.clientWidth;
    const H = cv.clientHeight;
    if (cv.width !== W * dpr || cv.height !== H * dpr) {
      cv.width = W * dpr;
      cv.height = H * dpr;
    }
    const g = cv.getContext("2d");
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, W, H);
    const css = getComputedStyle(document.documentElement);
    const col = (n) => css.getPropertyValue(n).trim();
    const padL = 34, padR = 8, padT = 8, padB = 20;
    const span = 360;
    const t1 = S.t + 20;
    const t0 = t1 - span;
    const yMin = 40, yMax = 400;
    const X = (t) => padL + ((t - t0) / span) * (W - padL - padR);
    const Y = (v) => padT + (1 - (Math.min(yMax, Math.max(yMin, v)) - yMin) / (yMax - yMin)) * (H - padT - padB);

    g.fillStyle = col("--band");
    g.fillRect(padL, Y(180), W - padL - padR, Y(70) - Y(180));

    g.font = "11px system-ui, sans-serif";
    g.fillStyle = col("--muted");
    g.strokeStyle = col("--grid");
    g.lineWidth = 1;
    for (const v of [70, 180, 250, 400]) {
      g.beginPath();
      g.setLineDash(v === 70 || v === 180 ? [] : [3, 4]);
      g.moveTo(padL, Y(v) + 0.5);
      g.lineTo(W - padR, Y(v) + 0.5);
      g.stroke();
      g.fillText(v, 4, Y(v) + 4);
    }
    g.setLineDash([]);
    const firstHour = Math.ceil(t0 / 60) * 60;
    for (let t = firstHour; t <= t1; t += 60) {
      const h = Math.floor(M.tod(t) / 60);
      g.fillText(`${h % 12 || 12}${h >= 12 ? "p" : "a"}`, X(t) - 8, H - 5);
    }

    // CGM dots.
    for (const r of S.readings) {
      if (r.v == null || r.t < t0) continue;
      g.fillStyle = col("--" + (rangeClass(r.v) || "ok"));
      g.beginPath();
      g.arc(X(r.t), Y(r.v), 2.6, 0, Math.PI * 2);
      g.fill();
    }

    // Food, insulin, fingersticks.
    for (const mk of S.markers) {
      if (mk.t < t0) continue;
      const x = X(mk.t);
      if (mk.type === "carb") {
        g.fillStyle = col("--food");
        g.beginPath();
        g.moveTo(x, H - padB - 12);
        g.lineTo(x - 5, H - padB - 2);
        g.lineTo(x + 5, H - padB - 2);
        g.fill();
      } else if (mk.type === "insulin" || mk.type === "basal") {
        g.fillStyle = col(mk.type === "basal" ? "--basal" : "--insulin");
        g.fillRect(x - 2, padT, 4, 12);
        g.fillText(mk.label, x + 4, padT + 10);
      } else if (mk.type === "finger") {
        g.fillStyle = col("--text");
        g.beginPath();
        g.moveTo(x, Y(mk.v) - 5);
        g.lineTo(x + 5, Y(mk.v));
        g.lineTo(x, Y(mk.v) + 5);
        g.lineTo(x - 5, Y(mk.v));
        g.fill();
      }
    }

    // Now line.
    g.strokeStyle = col("--muted");
    g.setLineDash([2, 3]);
    g.beginPath();
    g.moveTo(X(S.t) + 0.5, padT);
    g.lineTo(X(S.t) + 0.5, H - padB);
    g.stroke();
    g.setLineDash([]);
  }

  // ---------- controls ----------
  function buildControls() {
    const menu = $("#menu");
    for (const id of T1D.MENU) {
      const f = M.FOODS[id];
      const b = document.createElement("button");
      const tag = f.fast ? "for lows" : f.error >= 0.2 ? "no label" : "label";
      b.innerHTML = `<span>${f.name}</span><small>${tag}</small>`;
      if (f.fast) b.classList.add("fast");
      b.onclick = () => eat(id);
      menu.appendChild(b);
    }

    $("#dose-minus").onclick = () => {
      doseUnits = Math.max(0, doseUnits - 0.5);
      render();
    };
    $("#dose-plus").onclick = () => {
      doseUnits = Math.min(25, doseUnits + 0.5);
      render();
    };
    $("#bolus").onclick = () => {
      if (doseUnits <= 0) return;
      M.bolus(S, doseUnits);
      S.stats.decisions++;
      log(`You take ${doseUnits} units of rapid-acting insulin.`, "insulin");
      doseUnits = 0;
      render();
    };
    $("#basal").onclick = () => {
      M.takeBasal(S);
      S.stats.decisions++;
      log(`You take your long-acting insulin (${P.basalUnits} u).`, "insulin");
      render();
    };
    $("#fingerstick").onclick = () => {
      const v = fingerstick();
      log(`Fingerstick: ${v} mg/dL.`, v < 70 || v > 250 ? "warn" : "info");
      render();
    };
    $("#ketones").onclick = () => {
      S.stats.decisions++;
      const k = S.ketones;
      const msg = k < 0.6 ? "normal" : k < 1.5 ? "elevated, you need insulin and water" : k < 3 ? "high, risk of DKA, call your doctor" : "dangerous, go to the ER";
      log(`Ketone strip: ${k.toFixed(1)} mmol/L (${msg}).`, k < 0.6 ? "info" : "bad");
      render();
    };
    $("#water").onclick = () => {
      S.hydration = Math.min(100, S.hydration + 25);
      S.stats.decisions++;
      log("You drink some water.", "info");
      render();
    };
    $("#sensor").onclick = () => {
      S.stats.decisions++;
      S.cgm.status = "warmup";
      S.cgm.warmupUntil = S.t + 120;
      S.cgm.compressionUntil = 0;
      log("New sensor on. Two hours of warm-up with no readings. Fingersticks until then.", "info");
      render();
    };
    document.querySelectorAll("[data-act]").forEach((b) => {
      b.onclick = () => {
        if (S.forced) return;
        S.stats.decisions++;
        setActivity(b.dataset.act);
        if (b.dataset.act === "sleep") log("You go to bed. Your CGM is on watch.", "info");
        render();
      };
    });
    document.querySelectorAll("[data-speed]").forEach((b) => (b.onclick = () => setSpeed(Number(b.dataset.speed))));
    $("#sound").onclick = () => {
      sound = !sound;
      $("#sound").textContent = sound ? "Sound on" : "Sound off";
      $("#sound").setAttribute("aria-pressed", String(sound));
    };
    document.addEventListener("keydown", (e) => {
      if (e.code === "Space" && !modalOpen && e.target === document.body) {
        e.preventDefault();
        setSpeed(speed ? 0 : 1);
      }
    });
    window.addEventListener("resize", () => S && drawGraph());
  }

  function start() {
    reset();
    setSpeed(0);
    render();
    modal({
      title: "Type 1: A Day",
      noDecision: true,
      html: `
        <p>You're a software developer with type 1 diabetes. Your pancreas makes zero insulin, so every gram of food,
        every walk, every stressful meeting, and every hot afternoon is now your job to manage. It never stops,
        and the clock keeps running whether you're ready or not.</p>
        <ul class="intro">
          <li><b>Goal:</b> keep blood sugar between <b>70 and 180</b>. Below 70 is a low (dangerous fast). Above 250 is a high (dangerous slow).</li>
          <li><b>Rapid insulin:</b> 1 unit covers ${P.carbRatio} g of carbs and drops you ~${P.isf} mg/dL. It peaks in about 75 minutes and lasts 5 hours.</li>
          <li><b>You do the math.</b> Everything you eat or drink means reading labels, adding up carbs, and working out your dose:
          carbs ÷ ${P.carbRatio} + (glucose − ${P.target}) ÷ ${P.isf} − insulin on board. No calculator.</li>
          <li><b>Long-acting insulin:</b> ${P.basalUnits} units once a day, usually in the morning. Forget it and you'll climb all day. Take it twice and you'll crash.</li>
          <li><b>Your CGM</b> is about 10 minutes behind your real blood sugar, a little noisy, and sometimes just wrong. Fingersticks are accurate.</li>
          <li><b>Time:</b> 1 second = 1 minute. Pause with the ❚❚ button or the space bar.</li>
        </ul>
        <p class="hint">This is a simplified simulation for building empathy. It is not medical advice and must never be used for real dosing.</p>`,
      choices: [
        {
          label: "Start the day",
          run() {
            try {
              audio = audio || new (window.AudioContext || window.webkitAudioContext)();
            } catch (e) {
              audio = null;
            }
            setSpeed(1);
          },
        },
      ],
    });
  }

  buildControls();
  start();
  setInterval(frame, 40);
})();
