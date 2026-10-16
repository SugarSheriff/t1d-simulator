# Type 1: A Day

A real-time type 1 diabetes simulator. You live through one day as a software developer with T1D,
and the clock keeps running the whole time. Blood sugar is always moving, so there are no turns.

People hear "diabetes" and think it means skipping dessert. This simulator shows what it is really like:
- **Food is a guess.** Restaurant and break-room carbs are estimates, and the real number is hidden from you.
- **Insulin is slow and strong.** Rapid insulin peaks around 75 minutes and lasts 5 hours. Stacking doses causes crashes.
- **Long-acting insulin is on you.** Forget it and you'll climb all day toward DKA. Take it twice and you'll go low.
- **Everything moves the number.** That includes stress, heat, standing outside, exercise (for hours afterward), dehydration,
  a bad night's sleep, the dawn phenomenon, and plain randomness.
- **The tech is imperfect.** The CGM lags about 10 minutes behind your blood, is noisy, throws sensor errors, falls off when you sweat,
  needs a 2-hour warm-up, and gives false "compression lows" when you sleep on it.
- **Work doesn't pause for it.** You'll face a commute, standup, team lunch, a fire drill in a hot parking lot,
  a production incident, comments from coworkers, and insulin left in a hot car.
- **Nights aren't off.** Alarms wake you up, and lost sleep makes the next day harder.

At the end of the day you get your time in range, lows, highs, alarms, the number of decisions you made,
and a list of things that happened that you never saw.

## Run it

You don't need a build step or any dependencies. Just open `index.html` in a browser.

## Project layout

- `src/model.js`: the physiology model (insulin action curves, carb absorption, liver output, CGM behavior)
- `src/events.js`: scheduled and random events throughout the day
- `src/game.js`: the real-time loop, alarms, UI, and graph

## Disclaimer

This is a simplified model built for awareness and empathy. It is **not** medical advice,
and it must never be used to make real dosing decisions.
