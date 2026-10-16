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
  const settings = { doseMath: false, cycle: false };
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
  const hm = (mins) => `${Math.floor(mins / 60)}h ${Math.round(mins % 60)}m`;

  function newStats() {
    return {
      minutes: 0, inRange: 0, sum: 0, lows: 0, highs: 0, decisions: 0, alarms: 0, wakeups: 0,
      inLow: false, inHigh: false, min: 999, max: 0, mathTotal: 0, mathRight: 0, doseOff: 0, deviceIssues: 0,
    };
  }

  // Being sick or hormonal changes everything, and you find out when you wake up.
  function rollDay() {
    S.illness = Math.random() < 0.1 ? 1 : 0;
    S.cycle = settings.cycle && Math.random() < 0.3 ? 1 : 0;
    if (S.illness) log("You woke up with a sore throat and body aches. Being sick raises blood sugar and makes insulin work worse.", "warn");
    if (S.cycle) log("It's the week before your period. Hormones make you more insulin resistant for days.", "warn");
  }

  function reset() {
    S = M.createState(START);
    S.stats = newStats();
    S.fired = new Set();
    S.counts = {};
    S.alarm = { low: -999, high: -999, soon: -999, pod: new Set(), cgm: new Set() };
    S.podHistory = [];
    // Fake the last few hours so the graph isn't empty.
    for (let t = START - 240; t < START; t++) {
      const bg = S.bg - (START - t) * 0.08 + Math.sin(t / 37) * 4;
      S.history.push({ t, bg });
      if (t % 5 === 0) {
        S.readings.push({ t, v: Math.round(bg) });
        S.podHistory.push({ t, f: 1 });
      }
    }
    S.cgm.value = S.readings[S.readings.length - 1].v;
    S.cgm.lastValueAt = START;
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
    while (logEl.children.length > 150) logEl.lastChild.remove();
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
        const keepOpen = c.run && c.run() === false;
        if (keepOpen) return;
        if (!opts.noDecision) S.stats.decisions++;
        nextModal();
      };
      actions.appendChild(b);
    });
    if (!opts.node) actions.querySelector("button")?.focus();
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
    if (act === "sleep") setSpeed(SLEEP_SPEED);
    else if (wasSleeping) setSpeed(1);
  }

  function force(act, minutes, reason, onEnd) {
    setActivity(act);
    S.forced = { activity: act, until: S.t + minutes, reason, onEnd };
  }

  function latestReading() {
    if (S.cgm.status === "ok" && S.cgm.value != null && S.t - S.cgm.lastValueAt <= 15) return { v: S.cgm.value, src: "G7" };
    if (S.lastFinger && S.t - S.lastFinger.t <= 30) return { v: S.lastFinger.v, src: "fingerstick" };
    return null;
  }

  // Nothing goes in your mouth without math. The pod can only do its math with the carbs you give it.
  function eat(id) {
    const serv = M.serving(id);
    const f = serv.food;
    const r = latestReading();
    const iob = M.totalIOB(S);
    const ratio = M.ratioAt(S.t);
    const target = S.t < S.pod.activityUntil ? P.activityTarget : P.target;
    const qty = (q) => ({ 0.5: "½", 0.75: "¾", 1.25: "1¼", 1.5: "1½" }[q] || String(q));
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
        <label>Bolus (units)<input id="count-units" type="number" min="0" max="30" step="0.05" inputmode="decimal"></label>
      </div>
      ${
        f.fast
          ? ""
          : `<fieldset class="timing"><legend>When</legend>
              <label><input type="radio" name="timing" value="0" checked> Bolus and eat now</label>
              <label><input type="radio" name="timing" value="15"> Pre-bolus: eat in 15 min</label>
            </fieldset>`
      }
      <dl>
        <dt>Latest glucose</dt><dd>${r ? `${r.v} mg/dL (${r.src})` : "No recent reading. You're guessing."}</dd>
        <dt>Insulin on board</dt><dd>${iob.toFixed(2)} u</dd>
        <dt>Carb ratio now</dt><dd>1 u per ${ratio.ratio} g (${ratio.label})</dd>
        <dt>Correction</dt><dd>1 u drops ~${P.isf} mg/dL · target ${target}</dd>
      </dl>
      ${
        settings.doseMath
          ? `<p class="hint">Dose = carbs ÷ ${ratio.ratio} + (glucose − ${target}) ÷ ${P.isf}. Insulin on board only cancels out the
             correction part, not the meal. Below target, the correction is negative and shrinks the dose. Round to 0.05.</p>`
          : `<div class="podcalc"><b>Omnipod 5 bolus calculator</b><div id="podcalc-out">Enter your carbs. It can only be as right as your count.</div></div>`
      }
      ${f.fast ? `<p class="hint">Treating a low? You usually take 0.</p>` : ""}
      <p class="count-error" role="alert"></p>`;

    const carbsEl = wrap.querySelector("#count-carbs");
    const unitsEl = wrap.querySelector("#count-units");
    let unitsTouched = false;
    unitsEl.addEventListener("input", () => (unitsTouched = true));
    if (!settings.doseMath) {
      carbsEl.addEventListener("input", () => {
        const carbs = Number(carbsEl.value);
        const out = wrap.querySelector("#podcalc-out");
        if (carbsEl.value.trim() === "" || isNaN(carbs)) return;
        const sug = M.podSuggestion(S, carbs, r ? r.v : null);
        out.innerHTML =
          `Meal: ${carbs} ÷ ${sug.ratio} = ${sug.meal.toFixed(2)} u<br>` +
          (r ? `Correction: (${r.v} − ${sug.target}) ÷ ${P.isf}${sug.corr >= 0 && r.v > sug.target ? `, minus ${sug.iob.toFixed(2)} u on board` : ""} = ${sug.corr.toFixed(2)} u<br>` : "No glucose entered, so no correction.<br>") +
          `<strong>Suggested: ${sug.total.toFixed(2)} u</strong>`;
        if (!unitsTouched) unitsEl.value = sug.total.toFixed(2);
      });
    }

    modal({
      title: `Count it: ${f.name}`,
      node: wrap,
      choices: [
        {
          label: "Eat it",
          run() {
            const err = wrap.querySelector(".count-error");
            const carbsIn = carbsEl.value.trim();
            const unitsIn = unitsEl.value.trim();
            if (carbsIn === "" || isNaN(Number(carbsIn))) {
              err.textContent = "Add up the carbs first. Nobody's going to do it for you.";
              return false;
            }
            if (unitsIn === "" || isNaN(Number(unitsIn))) {
              err.textContent = "Decide on a dose. Enter 0 if you're not taking any.";
              return false;
            }
            const counted = Math.max(0, Math.round(Number(carbsIn)));
            const units = Math.max(0, Math.round(Number(unitsIn) * 20) / 20);
            const wait = Number(wrap.querySelector("input[name=timing]:checked")?.value || 0);
            finishEating(serv, counted, units, r, wait);
          },
        },
        { label: "Never mind", run: () => log(`You decide not to have the ${f.name.toLowerCase()}.`, "info") },
      ],
    });
    setTimeout(() => carbsEl.focus(), 0);
  }

  function finishEating(serv, counted, units, reading, wait) {
    const f = serv.food;
    const st = S.stats;
    const ideal = M.podSuggestion(S, serv.answer, reading ? reading.v : null).total;

    M.eat(S, serv, counted, wait);
    S.caffeine += serv.caffeine;
    S.alcohol += serv.alcohol;
    let delivered = 0;
    if (units > 0) {
      if (!M.podWorking(S.pod)) log("Your pod isn't working. That bolus never happened.", "bad");
      else delivered = M.bolus(S, units);
    }
    const what = units > 0 ? ` and bolused ${units} u` : " and took no insulin";
    log(wait ? `You pre-bolus for ${f.name.toLowerCase()} (counted ${counted} g)${what}. Food in ${wait} minutes.` : `You eat: ${f.name}. You counted ${counted} g${what}.`, "food");
    if (units > 0 && delivered > 0 && delivered < units) log(`Your pod only had ${delivered.toFixed(2)} u left.`, "bad");

    st.mathTotal++;
    if (Math.abs(counted - serv.answer) <= Math.max(2, serv.answer * 0.05)) {
      st.mathRight++;
      log("Your carb math checks out.", "good");
    } else {
      log(`Check your math: those numbers add up to ${serv.answer} g, not ${counted} g.`, "warn");
    }
    if (Math.abs(units - ideal) >= 1) {
      st.doseOff++;
      S.notes.push(`${fmt(S.t)}: ${f.name.toLowerCase()}: with the right carb count, the dose was about ${ideal} u. You took ${units} u.`);
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

  // ---------- pod + sensor ----------
  function changePod() {
    if (S.activity === "driving" || S.activity === "changing") {
      log(`You can't change your pod right now (${S.forced.reason.toLowerCase()}).`, "info");
      return;
    }
    if (S.supplies.pods <= 0) {
      log("You're out of pods. Your refill is stuck at the pharmacy. You'd have to dig out syringes and long-acting insulin.", "bad");
      return;
    }
    modal({
      title: "Change pod",
      body: "Fill a new pod with insulin, prime it, stick it on, and wait for the cannula to insert. Where's it going? Rotate sites, or scar tissue builds up and insulin stops absorbing well.",
      choices: ["Abdomen", "Back of arm", "Thigh", "Lower back"].map((site) => ({
        label: site,
        run: () => checkVial(site),
      })),
    });
  }

  function checkVial(site) {
    const sup = S.supplies;
    if (sup.vialAgeDays > 28) {
      modal({
        title: "Your insulin vial is old",
        body: `This vial was opened ${sup.vialAgeDays} days ago. Opened insulin is only good for 28 days. After that it slowly loses strength.`,
        choices: [
          { label: "Use it anyway", run: () => doPodChange(site, 0.8) },
          {
            label: "Open a new vial",
            run() {
              if (sup.vials > 0) {
                sup.vials--;
                sup.vialAgeDays = 0;
                sup.heatDamaged = false;
                doPodChange(site, 1);
              } else {
                log("You don't have a new vial. You use the old one.", "warn");
                doPodChange(site, 0.8);
              }
            },
          },
        ],
      });
    } else doPodChange(site, 1);
  }

  function doPodChange(site, potency) {
    const sup = S.supplies;
    sup.pods--;
    if (sup.heatDamaged) {
      potency *= 0.6;
      S.notes.push(`${fmt(S.t)}: the insulin in your new pod had been cooked in a hot car. It's only working at about ${Math.round(potency * 100)}%.`);
    } else if (potency < 1) {
      S.notes.push(`${fmt(S.t)}: the expired insulin in your new pod is only working at about ${Math.round(potency * 100)}%.`);
    }
    const bad = Math.random() < 0.15;
    if (bad) S.notes.push(`${fmt(S.t)}: your new pod landed on scar tissue on your ${site.toLowerCase()}. It absorbed about a third less insulin.`);
    S.pod.attached = false;
    S.stats.decisions++;
    log(`You pull off the old pod and fill a new one. No insulin while you do this.`, "info");
    force("changing", 10, "Changing your pod", () => {
      M.newPod(S, { siteFactor: bad ? 0.65 : 1, insulinPotency: potency });
      S.alarm.pod = new Set();
      log(`New pod on your ${site.toLowerCase()}. Automated Mode is back. ${sup.pods} spare pod${sup.pods === 1 ? "" : "s"} left.`, "good");
    });
    render();
  }

  function replaceSensor() {
    if (S.supplies.sensors <= 0) {
      log("You don't have any sensors left. Insurance won't refill early. Fingersticks until then.", "bad");
      return;
    }
    S.supplies.sensors--;
    S.stats.decisions++;
    M.newSensor(S);
    S.alarm.cgm = new Set();
    log(`New G7 on. 30-minute warm-up with no readings, so your pod is in Limited Mode. ${S.supplies.sensors} spare sensor${S.supplies.sensors === 1 ? "" : "s"} left.`, "info");
    render();
  }

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
    log(`G7 alarm: ${kind} ${v} ${arrow(S.cgm.trend)}`, urgent ? "bad" : "warn");
    if (S.activity === "sleep") wakeUp(`Your G7 alarm woke you up: ${kind.toUpperCase()} ${v} ${arrow(S.cgm.trend)}`, v < 100);
  }

  function deviceAlert(text) {
    S.stats.alarms++;
    S.stats.deviceIssues++;
    beep(false);
    log(text, "warn");
  }

  function podAlarm(title, body) {
    S.alarm.pod.add("alarm");
    S.alarm.podNag = S.t;
    S.stats.alarms++;
    S.stats.deviceIssues++;
    beep(true);
    log(`Pod alarm: ${title}.`, "bad");
    if (S.activity === "sleep") {
      S.stats.wakeups++;
      S.sleepDebt = Math.min(1, S.sleepDebt + 0.08);
      setActivity("sit");
    }
    modal({
      title,
      tone: "danger",
      body,
      choices: [
        { label: "Change pod now", run: () => changePod() },
        { label: "Deal with it later", run: () => log("You silence the pod. No insulin is going in.", "warn") },
      ],
    });
  }

  function wakeUp(message, low) {
    S.stats.wakeups++;
    S.sleepDebt = Math.min(1, S.sleepDebt + 0.08);
    const choices = [];
    if (low) choices.push({ label: "Eat glucose tabs", run: () => eat("tabs") });
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

  function checkCgmAlarms() {
    const c = S.cgm;
    const A = S.alarm;
    const v = c.value;
    if (v != null) {
      A.cgm.delete("signal");
      const soon = v + c.trend * 20;
      if (v < 55 && S.t - A.low >= 10) {
        A.low = S.t;
        alarm("Urgent Low", v, true);
      } else if (v >= 55 && soon < 55 && S.t - A.soon >= 30) {
        A.soon = S.t;
        alarm("Urgent Low Soon", v, true);
      } else if (v < 70 && S.t - A.low >= 20) {
        A.low = S.t;
        alarm("Low", v, false);
      }
      if (v > 250 && S.t - A.high >= 60) {
        A.high = S.t;
        alarm("High", v, false);
      }
    } else if (c.status === "ok" && S.t - c.lastValueAt >= 20 && !A.cgm.has("signal")) {
      A.cgm.add("signal");
      deviceAlert("G7: Signal loss. No readings for 20 minutes. Your pod is in Limited Mode.");
    }
    const once = (key, cond, text) => {
      if (cond && !A.cgm.has(key)) {
        A.cgm.add(key);
        deviceAlert(text);
      }
    };
    once("exp24", c.sensorAge >= M.G7_LIFE - 12 * 60 - 1440 && c.sensorAge < M.G7_LIFE, "G7: Sensor expires in 24 hours.");
    once("grace", c.sensorAge >= M.G7_LIFE - 12 * 60 && c.sensorAge < M.G7_LIFE, "G7: Sensor session ended. 12-hour grace period started. Replace it soon.");
    once("expired", c.status === "expired", "G7: Sensor expired. No more readings. Put on a new one.");
    once("failed", c.status === "failed", "G7: Sensor failed. Replace it.");
    once("none", c.status === "none", "G7: No sensor. Put on a new one.");
  }

  function checkPodAlarms() {
    const p = S.pod;
    const A = S.alarm.pod;
    // A dead pod doesn't alarm once and give up. It keeps going until you deal with it.
    const dead = !p.attached ? S.activity !== "changing" : !M.podWorking(p);
    if (dead && A.has("alarm") && S.t - (S.alarm.podNag || 0) >= 15) {
      S.alarm.podNag = S.t;
      S.stats.alarms++;
      beep(true);
      log("Pod alarm: still no insulin going in. Change your pod.", "bad");
      if (S.activity === "sleep") {
        S.stats.wakeups++;
        S.sleepDebt = Math.min(1, S.sleepDebt + 0.08);
        setActivity("sit");
      }
    }
    if (!p.attached) return;
    const once = (key, cond, fn) => {
      if (cond && !A.has(key)) {
        A.add(key);
        fn();
      }
    };
    once("exp1", p.age >= M.POD_EXPIRES - 60, () => deviceAlert("Pod expires in 1 hour."));
    once("exp", p.age >= M.POD_EXPIRES, () => deviceAlert("Pod expired. It'll keep going for an 8-hour grace period. Change it soon."));
    once("shut1", p.age >= M.POD_SHUTOFF - 60, () => deviceAlert("Pod shuts off in 1 hour. Change it now."));
    once("shut", p.age >= M.POD_SHUTOFF, () => podAlarm("Pod shut off", "Your pod hit 80 hours and stopped delivering insulin. Change it now."));
    once("low", p.reservoir < 10 && p.reservoir > 0, () => deviceAlert(`Low reservoir: ${Math.round(p.reservoir)} u of insulin left in your pod.`));
    once("empty", p.reservoir <= 0, () => podAlarm("Pod empty", "Your pod is out of insulin. Nothing is going in."));
    once("occ", p.occluded && p.missed >= 2, () => {
      p.failed = true;
      podAlarm(
        "Occlusion detected",
        "Insulin delivery has stopped. The cannula's been blocked for a while, which is why you've been running high. Change your pod now and check for ketones."
      );
    });
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
    if (S.t % 5 === 0) {
      S.podHistory.push({ t: S.t, f: M.podWorking(S.pod) && !S.pod.occluded ? S.pod.lastFactor : -1 });
      if (S.podHistory.length > 400) S.podHistory.shift();
    }

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

    if (M.updateCGM(S)) checkCgmAlarms();
    checkPodAlarms();

    const awake = S.activity !== "sleep";
    // Your body warns you too, but recent lows dull the warning (hypoglycemia unawareness).
    const feelAt = Math.max(45, 65 - 8 * S.lowTimes.length);
    if (S.bg < feelAt && !S.symptomNoted && awake) {
      S.symptomNoted = true;
      log(
        S.lowTimes.length
          ? "You suddenly realize you're shaky and soaked in sweat. This one snuck up on you. Recent lows dull your warning signs."
          : "You feel shaky, sweaty, and suddenly starving. That usually means you're low.",
        "warn"
      );
    } else if (S.bg > 85) S.symptomNoted = false;

    // Lows make you ravenous. Overtreating is how you end up at 300 an hour later.
    if (S.bg < 70 && awake && !S.hungerAsked && !modalOpen && Math.random() < 0.04) {
      S.hungerAsked = true;
      modal({
        title: "You're starving",
        body: "Your brain is screaming for sugar. You want to eat everything in sight, even though 15 g is supposed to be enough.",
        choices: [
          { label: "Stick to the Rule of 15. Wait.", run: () => log("You wait it out. It's miserable.", "info") },
          { label: "Eat a granola bar too", run: () => eat("granola") },
          { label: "Raid the snacks", run: () => eat("donut") },
        ],
      });
    } else if (S.bg > 90) S.hungerAsked = false;

    if (!awake && S.bg < 55 && S.cgm.value == null && Math.random() < 0.03) {
      wakeUp("You wake up drenched in sweat, heart pounding. No CGM reading to tell you how bad it is.", true);
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

    if (!awake) S.sleepDebt = Math.max(0, S.sleepDebt - 1 / 500);
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
          <div><b>${tir}%</b><span>time in range (goal: 70%+)</span></div>
          <div><b>${avg}</b><span>average mg/dL</span></div>
          <div><b>${st.lows}</b><span>lows</span></div>
          <div><b>${st.highs}</b><span>highs over 250</span></div>
          <div><b>${st.decisions}</b><span>decisions you made</span></div>
          <div><b>${st.alarms}</b><span>alarms and alerts</span></div>
          <div><b>${st.wakeups}</b><span>times woken up at night</span></div>
          <div><b>${st.deviceIssues}</b><span>pod/sensor problems</span></div>
          <div><b>${st.mathRight}/${st.mathTotal}</b><span>carb counts right</span></div>
          <div><b>${st.doseOff}</b><span>doses off by 1u+</span></div>
          <div><b>${Math.round(st.min)}–${Math.round(st.max)}</b><span>lowest–highest</span></div>
        </div>
        ${notes}
        <p class="closing">That was one day, with some of the best technology available. Tomorrow you do it again, and the day after that.
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
            S.supplies.vialAgeDays++;
            rollDay();
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
        ? "Your blood sugar stayed too low for too long and you lost consciousness. In real life this is an emergency: someone has to give you glucagon or call 911. It can happen at your desk, behind the wheel, or in your sleep."
        : "Without insulin, your body started burning fat for fuel and your blood turned acidic. Nausea, vomiting, confusion. On a pump there's no long-acting insulin in the background, so a failed pod can get you here in hours. In real life you'd be in the ER, maybe the ICU, on an IV insulin drip.",
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
    if (S.consciousness < 50) return "Confused, can't think straight";
    if (S.ketones > 1.5) return "Nauseous, stomach pain";
    if (b < 54) return "Shaky, vision blurring";
    if (b < 70) return "Shaky, sweaty, starving";
    if (b > 300) return "Exhausted, nauseous";
    if (b > 250) return "Thirsty, headache, foggy";
    if (S.t < S.lowHangoverUntil) return "Drained and foggy (low hangover)";
    if (b > 180) return "A bit sluggish";
    if (S.illness) return "Sick: sore throat, achy";
    if (S.hydration < 40) return "Dehydrated";
    if (S.sleepDebt > 0.5) return "Running on no sleep";
    return "Okay";
  }
  const ACT_LABEL = {
    sit: null, walk: "Walking", outside: "Outside", cardio: "Running", lift: "Lifting weights",
    sleep: "Asleep", driving: "Driving", meeting: "In a meeting", changing: "Changing your pod",
  };
  function where() {
    if (S.forced) return S.forced.reason;
    const base = ACT_LABEL[S.activity] || (S.location === "work" ? "At your desk" : "On the couch");
    if (S.activity === "outside") return `${base} · ${M.temperature(S.t)}°F`;
    return base;
  }

  function render() {
    $("#time").textContent = fmt(S.t);
    $("#day").textContent = `Day ${S.day}`;

    const c = S.cgm;
    const val = $("#cgm-value");
    let status;
    const lost = S.t < c.signalLostUntil;
    if (c.status === "ok" && c.value != null && !lost) {
      val.textContent = c.value <= 39 ? "LO" : c.value >= 401 ? "HI" : c.value;
      val.className = "cgm-value " + rangeClass(c.value);
      $("#cgm-arrow").textContent = arrow(c.trend);
      const daysLeft = Math.max(0, (M.G7_LIFE - 12 * 60 - c.sensorAge) / 1440);
      status = daysLeft > 0 ? `Dexcom G7 · ${daysLeft.toFixed(1)} days left` : "Dexcom G7 · grace period";
    } else {
      val.textContent = "---";
      val.className = "cgm-value off";
      $("#cgm-arrow").textContent = "";
      if (lost || (c.status === "ok" && S.t - c.lastValueAt > 10)) status = "Signal loss";
      else if (c.status === "warmup") status = `G7 warm-up · ${c.warmupUntil - S.t} min left`;
      else if (c.status === "error") status = "Brief sensor issue · no readings";
      else if (c.status === "failed") status = "Sensor failed · replace it";
      else if (c.status === "expired") status = "Sensor expired · replace it";
      else status = "No sensor · put on a new one";
    }
    $("#cgm-status").textContent = status;

    const p = S.pod;
    const working = M.podWorking(p);
    const activityOn = S.t < p.activityUntil;
    let mode;
    if (!p.attached) mode = S.forced && S.activity === "changing" ? "Changing pod" : "No pod on";
    else if (!working) mode = "Not delivering";
    else mode = (p.mode === "automated" ? "Automated" : "Limited") + (activityOn ? " · Activity" : "");
    $("#pod-mode").textContent = mode;
    $("#pod-mode").className = "pod-mode " + (!working ? "bad" : p.mode === "limited" ? "warn" : "ok");
    $("#pod-delivery").textContent = !working ? "No insulin going in" : p.lastFactor === 0 ? "Insulin suspended" : `${Math.round(p.lastFactor * 100)}% of basal`;
    $("#pod-age").textContent = p.attached ? `${Math.floor(p.age / 60)}h old · ${Math.max(0, p.reservoir).toFixed(0)} u left` : "—";
    $("#supplies").textContent = `Spare pods ${S.supplies.pods} · Sensors ${S.supplies.sensors} · Spare vials ${S.supplies.vials}`;
    const actBtn = $("#activity-mode");
    actBtn.textContent = activityOn ? `Activity on · ${hm(p.activityUntil - S.t)}` : "Activity feature";
    actBtn.classList.toggle("on", activityOn);

    const fs = S.lastFinger && S.t - S.lastFinger.t <= 60 ? `${S.lastFinger.v} (${S.t - S.lastFinger.t} min ago)` : "—";
    $("#finger").textContent = fs;
    $("#iob").textContent = M.totalIOB(S).toFixed(2) + " u";
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
      if ((a === "cardio" || a === "lift" || a === "sleep") && S.location === "work") disabled = true;
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
    el.classList.toggle("bad", inverse ? pct > 55 : pct < 40);
  }

  function drawGraph() {
    const cv = $("#graph");
    const dpr = window.devicePixelRatio || 1;
    const W = cv.clientWidth;
    const H = cv.clientHeight;
    if (!W || !H) return;
    if (cv.width !== W * dpr || cv.height !== H * dpr) {
      cv.width = W * dpr;
      cv.height = H * dpr;
    }
    const g = cv.getContext("2d");
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, W, H);
    const css = getComputedStyle(document.documentElement);
    const col = (n) => css.getPropertyValue(n).trim();
    const padL = 34, padR = 8, padT = 8, padB = 30;
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
      g.fillText(`${h % 12 || 12}${h >= 12 ? "p" : "a"}`, X(t) - 8, H - 3);
    }

    // Pod delivery strip: how much insulin the pod is giving vs. your programmed basal.
    const stripY = H - padB + 4;
    for (const d of S.podHistory) {
      if (d.t < t0) continue;
      const x = X(d.t);
      const w = Math.max(1, X(d.t + 5) - x);
      if (d.f < 0) g.fillStyle = col("--low");
      else if (d.f === 0) g.fillStyle = col("--grid");
      else {
        g.fillStyle = col("--insulin");
        g.globalAlpha = Math.min(1, 0.25 + d.f * 0.3);
      }
      g.fillRect(x, stripY, w, 8);
      g.globalAlpha = 1;
    }

    for (const r of S.readings) {
      if (r.v == null || r.t < t0) continue;
      g.fillStyle = col("--" + (rangeClass(r.v) || "ok"));
      g.beginPath();
      g.arc(X(r.t), Y(r.v), 2.6, 0, Math.PI * 2);
      g.fill();
    }

    for (const mk of S.markers) {
      if (mk.t < t0 || mk.t > t1) continue;
      const x = X(mk.t);
      if (mk.type === "carb") {
        g.fillStyle = col("--food");
        g.beginPath();
        g.moveTo(x, H - padB - 12);
        g.lineTo(x - 5, H - padB - 2);
        g.lineTo(x + 5, H - padB - 2);
        g.fill();
      } else if (mk.type === "insulin") {
        g.fillStyle = col("--insulin");
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
      doseUnits = Math.min(15, doseUnits + 0.5);
      render();
    };
    $("#bolus").onclick = () => {
      if (doseUnits <= 0) return;
      S.stats.decisions++;
      if (!M.podWorking(S.pod)) log("Your pod isn't working. That bolus never happened.", "bad");
      else {
        M.bolus(S, doseUnits);
        log(`You bolus a ${doseUnits} u correction.`, "insulin");
      }
      doseUnits = 0;
      render();
    };
    $("#change-pod").onclick = changePod;
    $("#activity-mode").onclick = () => {
      S.stats.decisions++;
      if (S.t < S.pod.activityUntil) {
        S.pod.activityUntil = 0;
        log("Activity feature off.", "info");
      } else {
        S.pod.activityUntil = S.t + 120;
        log("Activity feature on for 2 hours: target 150 and less automated insulin.", "insulin");
      }
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
      const msg = k < 0.6 ? "normal" : k < 1.5 ? "elevated, you need insulin and water, check your pod" : k < 3 ? "high, risk of DKA, change your pod and call your doctor" : "dangerous, go to the ER";
      log(`Ketone strip: ${k.toFixed(1)} mmol/L (${msg}).`, k < 0.6 ? "info" : "bad");
      render();
    };
    $("#water").onclick = () => {
      S.hydration = Math.min(100, S.hydration + 25);
      S.stats.decisions++;
      log("You drink some water.", "info");
      render();
    };
    $("#sensor").onclick = replaceSensor;
    document.querySelectorAll("[data-act]").forEach((b) => {
      b.onclick = () => {
        if (S.forced) return;
        S.stats.decisions++;
        setActivity(b.dataset.act);
        if (b.dataset.act === "sleep") log("You go to bed. Your G7 and pod are on watch.", "info");
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

  const api = {
    get S() {
      return S;
    },
    log, modal, force, eat, fmt, fingerstick, podAlarm,
  };

  function start() {
    reset();
    setSpeed(0);
    render();
    modal({
      title: "Type 1: A Day",
      noDecision: true,
      html: `
        <p>You're a software developer with type 1 diabetes. Your pancreas makes zero insulin. You wear an
        <b>Omnipod 5</b> insulin pump and a <b>Dexcom G7</b> CGM, some of the best tech there is. It still takes constant work,
        and the clock keeps running whether you're ready or not.</p>
        <ul class="intro">
          <li><b>Goal:</b> keep blood sugar between <b>70 and 180</b>. Below 70 is a low (dangerous fast). Above 250 is a high (dangerous slow).</li>
          <li><b>Your pod</b> gives you background insulin all day. In <b>Automated Mode</b> it uses your G7 to give more when you're rising
          and less when you're dropping. If your G7 stops sending readings, it drops to <b>Limited Mode</b> and just runs basal.
          Pods last 72 hours. If one fails, you have no long-acting insulin to fall back on.</li>
          <li><b>You count every carb.</b> Every food and drink means reading labels and adding it up. The pod's bolus calculator
          can only be as right as your count. Your carb ratio changes through the day (1:${P.ratios[1].ratio} in the morning, 1:${P.ratios[2].ratio} afternoon, 1:${P.ratios[3].ratio} evening).</li>
          <li><b>Pre-bolusing</b> 15 minutes before you eat cuts spikes, unless the food gets delayed.</li>
          <li><b>Your G7</b> is ~10 minutes behind your real blood sugar and sometimes just wrong. Fingersticks can be off by 15% too.</li>
          <li><b>Time:</b> 1 second = 1 minute. Pause with the ❚❚ button or the space bar.</li>
        </ul>
        <div class="options">
          <label><input type="checkbox" id="opt-dosemath"> Hard mode: no bolus calculator, do the dose math yourself</label>
          <label><input type="checkbox" id="opt-cycle"> Include menstrual cycle effects</label>
        </div>
        <p class="hint">This is a simplified simulation for building empathy. It is not medical advice and must never be used for real dosing.</p>`,
      choices: [
        {
          label: "Start the day",
          run() {
            settings.doseMath = $("#opt-dosemath").checked;
            settings.cycle = $("#opt-cycle").checked;
            try {
              audio = audio || new (window.AudioContext || window.webkitAudioContext)();
            } catch (e) {
              audio = null;
            }
            rollDay();
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
