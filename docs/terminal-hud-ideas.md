# Terminal HUD ideas

## Reminder, to-do, and calendar layer

Status: noted for later; do not implement during the current 0.4.3 test.

- Accept a natural-language request such as “remind me at 10:00 to do my homework” or “I have to go here on Friday.”
- Show the parsed title, date, time, and alert schedule for confirmation before saving.
- Provide an Agenda/to-do layer inside Terminal HUD with upcoming, completed, snoozed, and dismissed items.
- Allow multiple alert offsets, including a day before and shortly before the due time.
- When Terminal HUD is open, surface the alert as its own banner/bell without replacing the current screen header.
- When Terminal HUD is closed, use a phone notification that the Even app can mirror to the glasses.
- A scheduler in the Mac hub works only while the Mac is online and the hub is running. Apple Reminders or Calendar integration would be the later option for alerts that must survive the Mac being offline.
- Decide later whether Terminal HUD owns these items or syncs them with Apple Reminders/Calendar.

## Battery follow-up

- Remove the optional charging marker from the settings UI; charging state is not useful while the glasses are being worn.
