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
        "Your CGM is ~10 minutes behind your actual blood sugar.",
      choices: [
        {
          label: "Fingerstick first",
          run() {
            const v = api.fingerstick();
            api.log(`Fingerstick before driving: ${v} mg/dL.`, v < 80 ? "warn" : "info");
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
        api.log(
          "Your alarm goes off. Breakfast, insulin, your long-acting dose: nobody is going to remind you.",
          "info"
        );
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
            { label: "Go: brisket plate + sides (~75 g?)", run: () => api.eat("bbq") },
            { label: "Eat the sandwich you packed (~45 g)", run: () => api.eat("sandwich") },
            {
              label: "Skip lunch",
              run() {
                api.log("You skip lunch. You'll still need to watch for lows from earlier insulin.", "info");
              },
            },
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
            "Exercise is good for you. It can also drop your blood sugar for hours afterward, including in your sleep.",
          choices: [
            { label: "Gym (60 min)", run: () => (api.log("You head to the gym.", "info"), api.force("gym", 60, "At the gym")) },
            { label: "Walk the dog (30 min)", run: () => (api.log("You take the dog out.", "info"), api.force("walk", 30, "Walking the dog")) },
            { label: "Couch", run: () => api.log("You crash on the couch.", "info") },
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
    '"At least it\'s the kind you can control, right?"',
  ];

  // chance = expected times per hour while the condition holds; max = per day.
  const random = [
    {
      id: "sensor_error",
      chance: 0.05,
      max: 1,
      when: (S) => S.cgm.status === "ok" && S.activity !== "sleep",
      run(api) {
        const c = api.S.cgm;
        c.status = "error";
        c.errorUntil = api.S.t + Math.round(M.rand(45, 150));
        c.errorFails = Math.random() < 0.4;
        api.log("CGM: Sensor error. No readings. You're flying blind unless you fingerstick.", "warn");
      },
    },
    {
      id: "adhesive",
      chance: 0.5,
      max: 1,
      when: (S) => S.cgm.status !== "none" && (S.activity === "gym" || (S.activity === "outside" && M.temperature(S.t) >= 85)),
      run(api) {
        api.S.cgm.status = "none";
        api.log(
          "Sweat loosened the adhesive and your sensor caught on a door frame. It's gone. A new one needs a 2-hour warm-up.",
          "bad"
        );
      },
    },
    {
      id: "donuts",
      chance: 0.8,
      max: 1,
      when: (S) => S.location === "work" && M.tod(S.t) > at(8, 30) && M.tod(S.t) < at(11, 30) && S.activity === "sit",
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
      when: (S) => S.location === "work" && M.tod(S.t) > at(14, 0) && M.tod(S.t) < at(16, 30) && S.activity === "sit",
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
      id: "hot_pen",
      chance: 0.2,
      max: 1,
      when: (S) => S.location === "work" && M.tod(S.t) > at(12, 30) && M.tod(S.t) < at(17, 0) && S.activity === "sit",
      run(api) {
        const carTemp = M.temperature(api.S.t) + 35;
        api.modal({
          title: "Your insulin was in the car",
          body:
            `You realize your rapid-acting pen has been in the car all day. It's about ${carTemp}°F in there. ` +
            "Heat can ruin insulin, and you can't tell by looking at it.",
          choices: [
            {
              label: "Keep using it, it's all you have",
              run() {
                api.S.potency = 0.55;
                api.S.notes.push(`${api.fmt(api.S.t)}: the heat-damaged pen was only working at about 55% strength.`);
                api.log("You keep using the pen and hope it's fine.", "warn");
              },
            },
            {
              label: "Check your desk for the spare",
              run() {
                if (Math.random() < 0.5) api.log("Found the spare pen in your desk drawer. Past you did something right.", "good");
                else {
                  api.S.potency = 0.55;
                  api.S.notes.push(`${api.fmt(api.S.t)}: the heat-damaged pen was only working at about 55% strength.`);
                  api.log("The drawer is empty. You used the spare last month. Back to the hot pen.", "warn");
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
        api.S.notes.push(`${api.fmt(api.S.t)}: you rolled onto your sensor. It read falsely low (a "compression low").`);
      },
    },
  ];

  T1D.events = { scheduled, random };
})();
