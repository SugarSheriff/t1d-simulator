// Things that happen to you during the day. Some are on the calendar. Most aren't.
(function () {
  const T1D = (window.T1D = window.T1D || {});
  const M = T1D.model;
  const at = (h, m) => h * 60 + m;
  const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];

  function commute(api, dest) {
    const S = api.S;
    api.modal({
      title: dest === "work" ? "Time to drive to work" : "Time to drive home",
      body:
        "It's a 30 minute drive. Driving while low is like driving drunk: slow reactions, blurry vision, bad decisions. " +
        "Your G7 is ~10 minutes behind your actual blood sugar.",
      choices: [
        {
          label: "Fingerstick first",
          run() {
            const v = api.fingerstick();
            api.log(`Fingerstick before driving: ${v} mg/dL. (Meters can be off by up to 15%.)`, v < 80 ? "warn" : "info");
            api.force("driving", 30, "Driving", () => arrive(api, dest));
          },
        },
        {
          label: "Trust the CGM and go",
          run() {
            api.force("driving", 30, "Driving", () => arrive(api, dest));
          },
        },
      ],
    });
    S.driveLowWarned = false;
  }
  function arrive(api, dest) {
    api.S.location = dest;
    api.log(dest === "work" ? "You made it to work." : "You're home.", "info");
  }

  const scheduled = [
    {
      at: at(6, 45),
      run(api) {
        api.log("Your alarm goes off. Check your pod, check your sensor, figure out breakfast.", "info");
      },
    },
    { at: at(7, 50), run: (api) => commute(api, "work") },
    {
      at: at(9, 30),
      run(api) {
        api.log("Standup. 30 minutes. Hope your number behaves.", "info");
        api.force("meeting", 30, "In a meeting");
      },
    },
    {
      at: at(11, 55),
      run(api) {
        api.modal({
          title: "Team lunch",
          body:
            "The team is heading to a BBQ place. Sweet sauce, sides, and no nutrition labels. " +
            "Restaurant carb counts are basically guesses, and fat keeps it hitting for hours.",
          choices: [
            { label: "Go: BBQ plate with sides", run: () => api.eat("bbq") },
            { label: "Eat the sandwich you packed", run: () => api.eat("sandwich") },
            { label: "Skip lunch", run: () => api.log("You skip lunch.", "info") },
          ],
        });
      },
    },
    {
      at: at(13, 40),
      run(api) {
        const temp = M.temperature(api.S.t);
        api.log(
          `Fire alarm. Everyone's out in the parking lot. It's ${temp}°F with no shade, and nobody knows how long this will take.`,
          "warn"
        );
        api.force("outside", 35, "Fire drill (outside)");
      },
    },
    {
      at: at(15, 0),
      run(api) {
        api.S.stress = Math.min(1, api.S.stress + 0.6);
        api.log(
          "Production is down and everyone's on the incident call. Stress hormones push blood sugar up and make insulin work worse.",
          "warn"
        );
      },
    },
    { at: at(17, 15), run: (api) => commute(api, "home") },
    {
      at: at(18, 30),
      run(api) {
        api.log("Dinner time. What are you eating, and how much insulin does it need?", "info");
      },
    },
    {
      at: at(19, 30),
      run(api) {
        api.modal({
          title: "Evening",
          body:
            "Cardio usually drops you, lifting usually spikes you, and both can drop you hours later in your sleep. " +
            "Omnipod 5's Activity feature raises your target to 150 and cuts back insulin. It works best turned on before you start.",
          choices: [
            { label: "Go for a run (45 min)", run: () => (api.log("You head out for a run.", "info"), api.force("cardio", 45, "Running")) },
            { label: "Lift weights (60 min)", run: () => (api.log("You head to the gym to lift.", "info"), api.force("lift", 60, "Lifting weights")) },
            { label: "Walk the dog (30 min)", run: () => (api.log("You take the dog out.", "info"), api.force("walk", 30, "Walking the dog")) },
            { label: "Couch", run: () => api.log("You crash on the couch.", "info") },
          ],
        });
      },
    },
    {
      at: at(20, 45),
      run(api) {
        api.modal({
          title: "A friend texts",
          body: '"Want to grab a beer?" Alcohol shuts down your liver\'s sugar release for hours. The low it causes usually comes overnight.',
          choices: [
            { label: "Have a beer", run: () => api.eat("beer") },
            { label: "Pass", run: () => api.log("You pass on the beer.", "info") },
          ],
        });
      },
    },
    {
      at: at(22, 30),
      run(api) {
        api.log("It's getting late. Going to bed with a steady number matters. Lows hit hard overnight.", "info");
      },
    },
  ];

  const COMMENTS = [
    '"Should you be eating that?"',
    '"My grandma had diabetes. She lost a foot."',
    '"You don\'t look diabetic."',
    '"Did you get it from eating too much sugar as a kid?"',
    '"Can\'t you just take a pill for that?"',
    '"Is that a nicotine patch on your arm?"',
    '"Your pump does all the work now though, right?"',
  ];

  const INSURANCE = [
    "The pharmacy says your pods need a new prior authorization before they can refill them.",
    'Insurance denied your G7 sensor refill: "too soon to refill." A sensor fell off last week.',
    "Your pod order is on backorder. The pharmacy doesn't know when it'll ship.",
    "Insurance changed its formulary. Your insulin now needs a prior authorization.",
  ];

  const atWork = (S) => S.location === "work" && S.activity === "sit" && !S.forced;

  // chance = expected times per hour while the condition holds; max = per day.
  const random = [
    {
      id: "sensor_error",
      chance: 0.04,
      max: 1,
      when: (S) => S.cgm.status === "ok" && S.activity !== "sleep",
      run(api) {
        const c = api.S.cgm;
        c.status = "error";
        c.errorUntil = api.S.t + Math.round(M.rand(30, 120));
        c.errorFails = Math.random() < 0.4;
        api.log("G7: Brief sensor issue. No readings. Your pod drops to Limited Mode and can't adjust insulin.", "warn");
      },
    },
    {
      id: "signal_loss",
      chance: 0.12,
      max: 1,
      when: (S) => S.cgm.status === "ok" && S.location === "work" && S.activity !== "driving",
      run(api) {
        api.S.cgm.signalLostUntil = api.S.t + Math.round(M.rand(25, 50));
        api.log("You walked away from your phone. Your G7 has nothing to talk to: signal loss.", "info");
      },
    },
    {
      id: "ripped_off",
      chance: 0.5,
      max: 1,
      when: (S) => S.activity === "cardio" || S.activity === "lift" || (S.activity === "outside" && M.temperature(S.t) >= 85),
      run(api) {
        const S = api.S;
        if (Math.random() < 0.5 && S.cgm.status !== "none") {
          S.cgm.status = "none";
          api.log("Sweat loosened the adhesive and your G7 caught on a door frame. It's gone.", "bad");
        } else if (S.pod.attached) {
          S.pod.attached = false;
          api.podAlarm("Pod ripped off", "Sweat loosened the adhesive and your pod caught on a door frame. No insulin is going in until you put on a new one.");
        }
      },
    },
    {
      id: "occlusion",
      chance: 0.025,
      max: 1,
      when: (S) => M.podWorking(S.pod) && !S.pod.occluded,
      run(api) {
        // Silent. The pod won't notice until it's missed a couple of units.
        api.S.pod.occluded = true;
        api.S.notes.push(`${api.fmt(api.S.t)}: your pod's cannula kinked. Insulin stopped reaching you long before the alarm went off.`);
      },
    },
    {
      id: "pod_error",
      chance: 0.015,
      max: 1,
      when: (S) => M.podWorking(S.pod),
      run(api) {
        api.S.pod.failed = true;
        api.podAlarm("Pod error", "Your pod is screaming. It's failed and stopped delivering insulin. You need to change it now.");
      },
    },
    {
      id: "donuts",
      chance: 0.8,
      max: 1,
      when: (S) => atWork(S) && M.tod(S.t) > at(8, 30) && M.tod(S.t) < at(11, 30),
      run(api) {
        api.modal({
          title: "Donuts in the break room",
          body: "Someone brought a dozen. Glazed? Filled? Who knows how many carbs.",
          choices: [
            { label: "Have one", run: () => api.eat("donut") },
            { label: "Pass", run: () => api.log("You pass on the donuts.", "info") },
          ],
        });
      },
    },
    {
      id: "cake",
      chance: 0.4,
      max: 1,
      when: (S) => atWork(S) && M.tod(S.t) > at(14, 0) && M.tod(S.t) < at(16, 30),
      run(api) {
        api.modal({
          title: "Birthday cake",
          body: "It's someone's birthday. Everyone's watching to see if you'll have a piece.",
          choices: [
            { label: "Have a slice", run: () => api.eat("cake") },
            { label: "Pass", run: () => api.log('You pass. Someone says "Oh right, you can\'t have sugar."', "info") },
          ],
        });
      },
    },
    {
      id: "comment",
      chance: 0.25,
      max: 2,
      when: (S) => S.location === "work" && S.activity !== "driving",
      run(api) {
        api.S.stress = Math.min(1, api.S.stress + 0.08);
        api.log(`A coworker: ${pick(COMMENTS)}`, "info");
      },
    },
    {
      id: "insurance",
      chance: 0.3,
      max: 1,
      when: (S) => atWork(S) && M.tod(S.t) > at(10, 0) && M.tod(S.t) < at(16, 0),
      run(api) {
        api.S.stress = Math.min(1, api.S.stress + 0.2);
        api.log(`${pick(INSURANCE)} You spend your break on hold.`, "warn");
        api.force("sit", 25, "On hold with insurance");
      },
    },
    {
      id: "meal_delay",
      chance: 1.5,
      max: 1,
      when: (S) => S.carbs.some((c) => c.t > S.t) && S.location === "work",
      run(api) {
        const S = api.S;
        for (const c of S.carbs) if (c.t > S.t) c.t += 20;
        for (const m of S.markers) if (m.type === "carb" && m.t > S.t) m.t += 20;
        api.log('Your manager stops you to "quickly" go over something. Your food waits. Your insulin doesn\'t.', "warn");
      },
    },
    {
      id: "unexplained",
      chance: 0.1,
      max: 1,
      when: (S) => S.activity !== "sleep",
      run(api) {
        // Silent on purpose. Sometimes it just goes up and you never find out why.
        api.S.hiddenRise += 0.6;
        api.S.notes.push(`${api.fmt(api.S.t)}: an unexplained hormone surge pushed you up. There was no warning and no cause you could fix.`);
      },
    },
    {
      id: "hot_car",
      chance: 0.2,
      max: 1,
      when: (S) => atWork(S) && M.tod(S.t) > at(12, 30) && M.tod(S.t) < at(17, 0),
      run(api) {
        const S = api.S;
        const carTemp = M.temperature(S.t) + 35;
        api.modal({
          title: "Your backup kit was in the car",
          body:
            `Your spare pods and insulin vial have been sitting in a ${carTemp}°F car all day. ` +
            "Heat can ruin insulin, and you can't tell by looking at it.",
          choices: [
            {
              label: "It's probably fine",
              run() {
                S.supplies.heatDamaged = true;
                api.log("You leave the kit in the car and hope for the best.", "warn");
              },
            },
            {
              label: "Toss the vial, use your spare",
              run() {
                if (S.supplies.vials > 0) {
                  S.supplies.vials--;
                  S.supplies.vialAgeDays = 0;
                  api.log("You toss the cooked vial. That's a few hundred dollars of insulin in the trash.", "info");
                } else {
                  S.supplies.heatDamaged = true;
                  api.log("You don't have a spare vial. You'll have to use the hot one next time you change your pod.", "warn");
                }
              },
            },
          ],
        });
      },
    },
    {
      id: "compression",
      chance: 0.35,
      max: 1,
      when: (S) => S.activity === "sleep" && S.cgm.status === "ok",
      run(api) {
        api.S.cgm.compressionUntil = api.S.t + 35;
        api.S.notes.push(`${api.fmt(api.S.t)}: you rolled onto your G7. It read falsely low (a "compression low"), so your pod cut your insulin for nothing.`);
      },
    },
  ];

  T1D.events = { scheduled, random };
})();
