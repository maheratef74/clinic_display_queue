# Clinic Queue — patient calling display

Plain HTML + CSS + vanilla JavaScript with a small Node.js backend. No database, no build step, no external dependencies.

## Structure

```
clinic-queue/
├── index.html        Control page (receptionist / doctor)
├── display.html      TV / monitor page
├── server.js          Node server, queue actions, and JSON persistence
├── queue-state.json   Created automatically; shared queue data
├── config.js          Clinic name and speech settings
├── queue.js           Browser API facade
├── control.js         Control page UI
└── display.js         Display page: rendering, speech, fullscreen
```

## Run

1. Install Node.js, then run `node server.js` from this folder.
2. Open `http://localhost:8000/index.html` for the control page.
3. Open `http://localhost:8000/display.html` on the display device.
4. For other devices on the same network, replace `localhost` with the server computer's LAN IP address, for example `http://192.168.1.20:8000/index.html`.

The server stores the queue in `queue-state.json` beside `server.js`. Do not open the HTML files directly with `file://`.

## How it works

- **State** lives on the Node server in `queue-state.json`:
  `{ patients, currentPatientId, nextNormalNumber, nextEmergencyNumber, lastAction, lastActionId }`.
  Every action is validated and serialized by the server before the JSON file is updated.
- **Real-time sync**: connected pages receive server-sent events from `/api/events`, so multiple control devices and display screens share the same state.
- **Order**: automatic flow is first-added, first-called. In the control page, waiting patients can be moved up/down, moved directly to the first/last position, or called immediately; this changes the same queue order used by **التالي**.
  Emergency patients have their own numbering (طوارئ1, طوارئ2…) but do **not** jump the queue.
- **Numbers**: suggested automatically per type; can be overridden (digits only, Arabic-Indic digits accepted). Change the emergency prefix in `config.js` if needed.
  Two *active* (waiting / called) patients cannot share a number.
- **History**: completed and skipped patients stay in state; only the latest 20 are kept.
- **Reset** clears everything, including history, and numbering restarts at 1 and طوارئ1.

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
- **Network access**: other devices must be able to reach the server computer on port 8000. Configure the firewall if necessary.
- **Security**: this basic server has no login or HTTPS. Use it only on a trusted local network, and protect `queue-state.json` because it contains patient names.
- The server computer's `queue-state.json` is the source of truth; browser cache or site-data clearing does not delete it.
- Fullscreen is not available on iPhone Safari (the button hides itself). The browser's normal way out (Esc / F11) always works.
- The display and control pages must not be opened from different origins (e.g. one from `file://` and one from `localhost`).

## Manual test checklist

1. Add "أحمد محمد" (عادي) → number **1**. Add "محمد علي" (عادي) → **2**. Add "مصطفى أحمد" (طوارئ) → **طوارئ1**.
2. Click **التالي** → display shows **1 / أحمد محمد** instantly and speaks the name only.
3. Click **إعادة النداء** → same patient, name spoken again.
4. Click **التالي** → display shows **2 / محمد علي**.
5. Refresh the display → still **2 / محمد علي**, silent.
6. Close the whole browser, reopen both pages → state preserved, silent.
7. **التالي** twice more → **طوارئ1** in red on the display. **إنهاء** → display shows "لا يوجد مريض يتم نداؤه حاليًا".
8. **تخطي** on a current patient → the next one is shown and spoken; the skipped one appears in **السجل**.
9. Try adding an empty name → friendly message. Try an already-used number → friendly message.
10. Use the arrows to reorder waiting patients, or **نداء الآن** to call one directly; then **التالي** continues from the updated order.
11. **إعادة تعيين الطابور** → confirmation → everything cleared; next numbers are **1** and **طوارئ1**.
12. Display: **ملء الشاشة** enters fullscreen, Esc exits.
