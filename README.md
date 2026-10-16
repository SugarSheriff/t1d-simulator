# Type 1: A Day

A real-time type 1 diabetes simulator. You live through one day as a software developer with T1D,
wearing an **Omnipod 5** insulin pump and a **Dexcom G7** CGM. The clock keeps running the whole time.
Blood sugar is always moving, so there are no turns.

People hear "diabetes" and think it means skipping dessert. Some people think the tech handles it now.
This simulator shows what it's really like, even with some of the best technology available.

## What it simulates

**Counting and dosing**
- **You count every carb.** Every food or drink opens a "Count it" screen. You read the labels,
  multiply by how much you're actually having, and add it up. The pod's bolus calculator can only be as right as your count.
- **Your carb ratio changes through the day:** 1:8 in the morning, 1:10 in the afternoon, and 1:11 in the evening.
- **The bolus calculator works like a real one.** Insulin on board only cancels out the correction, not the meal,
  and below target a reverse correction shrinks the dose.
- **You can pre-bolus** 15 minutes before eating to cut spikes. But your manager might stop you on the way to your food.
- **Hard mode** turns off the calculator so you do the dose math yourself.
- **Food is still a guess.** Restaurant and break-room food has no label. Even perfect math can be wrong.

**Omnipod 5**
- **Automated Mode** adjusts insulin every 5 minutes based on your G7. It suspends when you're dropping
  and gives more when you're rising. The graph shows a delivery strip so you can watch it work.
- **Limited Mode:** when the G7 stops sending readings, the pod can't adjust and just runs basal.
- **The Activity feature** raises your target to 150 and cuts back insulin around exercise.
- **Pods expire at 72 hours** and have an 8-hour grace period, then shut off.
  They also run low on insulin, get ripped off, kink (occlusions the pod doesn't catch for hours), and fail outright.
- **There's no long-acting insulin backup.** A dead pod means moderate ketones in about 5 hours and DKA in about 9.
- **Pod changes come with real problems:** site rotation, scar tissue that absorbs less insulin, insulin that's older than 28 days,
  and a backup kit that got cooked in a hot car.

**Dexcom G7**
- It reads every 5 minutes about 10 minutes behind your blood, with noise. The range is 40–400.
- Alerts: Urgent Low, Urgent Low Soon, Low, High, and signal loss.
- **Sensor problems:** a 30-minute warm-up, a 10-day life with a 12-hour grace period, brief sensor issues, failed sensors,
  adhesive giving out from sweat, and compression lows that make your pod cut insulin for nothing.
- **Fingersticks aren't ground truth either.** Meters can be off by up to 15%.

**Your body**
- **Lows:** you can treat with the Rule of 15, but lows make you ravenous, and overtreating leads to a rebound high.
  Lows also leave a hangover (fatigue and fog for hours).
- **Hypoglycemia unawareness:** recent lows dull your warning signs. How long you can stay low before passing out varies by person.
- **What moves your number:** dawn phenomenon, stress, heat (which can push you up *or* down), cardio (down) vs.
  lifting (up, then down later), dehydration, poor sleep, caffeine, alcohol (delayed overnight lows),
  being sick, menstrual cycle effects (optional), and plain randomness.

**Life**
- **Work doesn't pause:** commute (don't drive low), standup, team lunch, a fire drill in a hot parking lot,
  a production incident, coworker comments, and time on hold with insurance over prior authorizations and refills.
- **Supplies run out.** You have a limited number of spare pods, sensors, and insulin vials.
- **Nights aren't off.** Alarms wake you up, and lost sleep makes the next day harder.

At the end of each day you get your time in range, lows, highs, alarms, nighttime wake-ups, pod and sensor problems,
how many carb counts you got right, which doses were off, and a list of things that happened that you never saw.

## Run it

You don't need a build step or any dependencies. Just open `index.html` in a browser.
It also works on GitHub Pages as is.

## Project layout

- `src/model.js`: the physiology model, Omnipod 5 automation, Dexcom G7 behavior, and the foods
- `src/events.js`: scheduled and random events throughout the day
- `src/game.js`: the real-time loop, alarms, the count/bolus screen, UI, and graph

## Disclaimer

This is a simplified model built for awareness and empathy. The Omnipod 5 algorithm here is a rough approximation,
not Insulet's actual algorithm. It is **not** medical advice, and it must never be used to make real dosing decisions.
