# Clinic Queue — patient calling display

Plain HTML + CSS + vanilla JavaScript. No backend, no database, no build step, no dependencies.

## Structure

```
clinic-queue/
├── index.html        Control page (receptionist / doctor)
├── display.html      TV / monitor page
├── css/
│   ├── style.css     Control page styles
│   └── display.css   Display page styles
└── js/
    ├── config.js     Clinic name, speech language/rate, history size  ← edit the clinic name here
    ├── queue.js      State model, localStorage, BroadcastChannel / storage sync (shared)
    ├── control.js    Control page UI only
    └── display.js    Display page: rendering, speech, fullscreen
```

## Run

1. Open `index.html` on the reception computer (control page).
2. Click **فتح شاشة العرض** — or open `display.html` in another tab/window of the **same browser** — and drag it to the TV.
3. On the display page click **ملء الشاشة** once. That click also unlocks sound (see below).

If the display does not update in your browser (some browsers isolate `file://` pages from each other), serve the
folder with any static file server, e.g. `python -m http.server 8000`, and open `http://localhost:8000/index.html`
and `http://localhost:8000/display.html`. Or use Chrome / Edge.

## How it works

- **State** lives in `localStorage` under `clinic_queue_state_v1`:
  `{ patients, currentPatientId, nextNormalNumber, nextEmergencyNumber, lastAction, lastActionId }`.
  Every action loads the fresh state, changes it, saves it, then broadcasts it.
- **Real-time sync**: one `BroadcastChannel("clinic_queue_channel")`. Messages look like
  `{ type: "QUEUE_UPDATED", action: "CALL_NEXT" | "RECALL" | ..., state, eventId }`.
  If `BroadcastChannel` is missing, the `storage` event is used instead (state carries the same `lastAction` / `lastActionId`).
  Set `forceStorageFallback: true` in `config.js` to test the fallback.
- **Order**: automatic flow is first-added, first-called. In the control page, waiting patients can be moved up/down, moved directly to the first/last position, or called immediately; this changes the same queue order used by **التالي**.
  Emergency patients have their own numbering (طوارئ1, طوارئ2…) but do **not** jump the queue.
- **Numbers**: suggested automatically per type; can be overridden (digits only, Arabic-Indic digits accepted). Change the emergency prefix in `config.js` if needed.
  Two *active* (waiting / called) patients cannot share a number.
- **History**: completed and skipped patients stay in state; only the latest 20 are kept.
- **Reset** clears everything, including history, and numbering restarts at 1 and E1.

## Arabic speech

- Uses `window.speechSynthesis`. Only the patient name is spoken.
- Voice choice: exact `ar-EG` → any `ar-*` voice → browser default voice (with `lang = ar-EG`).
  If the engine reports the language/voice as unavailable, it retries once with the plain default voice.
- Speech happens only for a **new** event (`CALL_NEXT`, `SKIP` that calls someone, `RECALL`). The display remembers the last
  handled `eventId`, so refreshing / reopening never speaks.

## Known limitations

- **Sound needs one interaction.** Browsers block automatic speech until the page has had a click or key press.
  The display shows a small "اضغط في أي مكان لتفعيل الصوت" hint until then (and again if the browser blocks speech).
  After a page refresh, click once again.
- **Voices depend on the device.** If no Arabic voice is installed, the default voice will read the name (possibly badly).
  Install an Arabic voice / language pack in the operating system, then test with **إعادة النداء**.
- **Same browser, same profile, same origin** for both pages. Private/incognito windows and different browsers do not share data.
- Clearing site data in the browser deletes the queue.
- Fullscreen is not available on iPhone Safari (the button hides itself). The browser's normal way out (Esc / F11) always works.
- The display and control pages must not be opened from different origins (e.g. one from `file://` and one from `localhost`).

## Manual test checklist

1. Add "أحمد محمد" (عادي) → number **1**. Add "محمد علي" (عادي) → **2**. Add "مصطفى أحمد" (طوارئ) → **E1**.
2. Click **التالي** → display shows **1 / أحمد محمد** instantly and speaks the name only.
3. Click **إعادة النداء** → same patient, name spoken again.
4. Click **التالي** → display shows **2 / محمد علي**.
5. Refresh the display → still **2 / محمد علي**, silent.
6. Close the whole browser, reopen both pages → state preserved, silent.
7. **التالي** twice more → **E1** in red on the display. **إنهاء** → display shows "لا يوجد مريض يتم نداؤه حاليًا".
8. **تخطي** on a current patient → the next one is shown and spoken; the skipped one appears in **السجل**.
9. Try adding an empty name → friendly message. Try an already-used number → friendly message.
10. Use the arrows to reorder waiting patients, or **نداء الآن** to call one directly; then **التالي** continues from the updated order.
11. **إعادة تعيين الطابور** → confirmation → everything cleared; next numbers are **1** and **طوارئ1**.
12. Display: **ملء الشاشة** enters fullscreen, Esc exits.
