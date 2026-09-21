/* ==========================================================
   display.js — شاشة العرض (تلفاز / شاشة كبيرة)
   - تعرض المريض الحالي فقط.
   - تنطق الاسم فقط عند: نداء جديد (التالي / التخطي) أو إعادة النداء.
   - لا تنطق عند فتح الصفحة أو تحديثها: نتذكر آخر eventId تمت معالجته.
   ========================================================== */
(function () {
  "use strict";

  const CFG = window.CLINIC_CONFIG || {};
  const SPEAK_ACTIONS = ["CALL_NEXT", "RECALL", "SKIP"];
  const $ = (id) => document.getElementById(id);

  const stage = $("stage");
  const callBox = $("callBox");
  const numberEl = $("number");
  const nameEl = $("name");
  const canSpeak = "speechSynthesis" in window && "SpeechSynthesisUtterance" in window;

  // ---------- العرض ----------
  function render(state, flash) {
    const cur = Queue.currentPatient(state);
    stage.dataset.state = cur ? "active" : "empty";
    stage.dataset.type = cur ? cur.type : "normal"; // بدون مريض: يعود اللون الافتراضي
    if (cur) {
      numberEl.textContent = cur.number;
      numberEl.dataset.len = String(Math.min(cur.number.length, 5));
      nameEl.textContent = cur.name;
      nameEl.dataset.size = cur.name.length > 44 ? "sm" : cur.name.length > 28 ? "md" : "lg";
    }
    if (flash) { // حركة قصيرة تلفت النظر عند النداء
      callBox.classList.remove("flash");
      void callBox.offsetWidth; // إعادة تشغيل الحركة
      callBox.classList.add("flash");
    }
  }

  // ---------- النطق ----------
  // المتصفح يمنع النطق التلقائي حتى يتفاعل المستخدم مع الصفحة مرة واحدة (نقرة/مفتاح)
  const hint = $("soundHint");
  let unlocked = false;

  function showHint() { unlocked = false; if (canSpeak) hint.hidden = false; }
  function unlock() {
    if (unlocked) return;
    unlocked = true;
    hint.hidden = true;
    if (!canSpeak) return;
    try { // نطق صامت لفتح الصوت في Safari
      const u = new SpeechSynthesisUtterance(" ");
      u.volume = 0;
      window.speechSynthesis.speak(u);
    } catch (e) { /* تجاهل */ }
  }
  ["click", "keydown", "touchend"].forEach((evt) => document.addEventListener(evt, unlock, { passive: true }));
  if (!(navigator.userActivation && navigator.userActivation.hasBeenActive)) showHint();

  function pickVoice() {
    const voices = window.speechSynthesis.getVoices() || [];
    const lang = (v) => String(v.lang || "").toLowerCase().replace("_", "-");
    const want = String(CFG.speechLang || "ar-EG").toLowerCase();
    return voices.filter((v) => lang(v) === want)[0] ||
           voices.filter((v) => lang(v).indexOf("ar") === 0)[0] ||
           null;
  }

  // plain=true → بدون لغة/صوت محدد (الصوت الافتراضي للمتصفح)
  function speak(text, plain) {
    if (!canSpeak || !text) return;
    try {
      const u = new SpeechSynthesisUtterance(text);
      u.rate = CFG.speechRate || 0.9;
      if (!plain) {
        u.lang = CFG.speechLang || "ar-EG";
        const v = pickVoice();
        if (v) { u.voice = v; u.lang = v.lang; }
      }
      u.onerror = function (e) {
        const err = e && e.error;
        if (err === "not-allowed") showHint();
        else if (!plain && (err === "language-unavailable" || err === "voice-unavailable")) speak(text, true);
      };
      window.speechSynthesis.cancel(); // لا نكدّس نداءات قديمة
      setTimeout(function () { window.speechSynthesis.speak(u); }, 80);
    } catch (e) { /* تجاهل */ }
  }
  if (canSpeak) window.speechSynthesis.getVoices(); // تسخين قائمة الأصوات

  // ---------- استقبال التحديثات ----------
  let handledEventId = null;

  function onState(state, action, eventId) {
    const isNewEvent = !!eventId && eventId !== handledEventId;
    if (eventId) handledEventId = eventId;
    const cur = Queue.currentPatient(state);
    const isCall = isNewEvent && !!cur && SPEAK_ACTIONS.indexOf(action) !== -1;
    render(state, isCall);
    if (isCall) speak(cur.name);
  }

  const initial = Queue.load();
  handledEventId = initial.lastActionId; // الحالة الأولية تُعتبر "مُعالَجة": لا نطق عند فتح الصفحة
  render(initial, false);
  Queue.subscribe(onState);

  $("clinicName").textContent = CFG.clinicName || "";
  document.title = "شاشة النداء — " + (CFG.clinicName || "");

  // ---------- ملء الشاشة ----------
  const btnFs = $("btnFullscreen");
  const root = document.documentElement;
  const reqFs = root.requestFullscreen || root.webkitRequestFullscreen || root.msRequestFullscreen;
  const exitFs = document.exitFullscreen || document.webkitExitFullscreen || document.msExitFullscreen;
  const fsElement = () => document.fullscreenElement || document.webkitFullscreenElement || null;

  if (!reqFs) btnFs.hidden = true; // مثل iPhone: لا يدعم الميزة
  btnFs.addEventListener("click", function () {
    try {
      const p = fsElement() ? exitFs.call(document) : reqFs.call(root);
      if (p && p.catch) p.catch(function () {});
    } catch (e) { /* تجاهل */ }
  });
  function syncFsLabel() { btnFs.textContent = fsElement() ? "إنهاء ملء الشاشة" : "ملء الشاشة"; }
  document.addEventListener("fullscreenchange", syncFsLabel);
  document.addEventListener("webkitfullscreenchange", syncFsLabel);

  // ---------- إخفاء الزر والمؤشر بعد فترة سكون ----------
  let idleTimer = null;
  function wake() {
    document.body.classList.remove("idle");
    clearTimeout(idleTimer);
    idleTimer = setTimeout(function () { document.body.classList.add("idle"); }, 4000);
  }
  ["mousemove", "mousedown", "keydown", "touchstart"].forEach((evt) => document.addEventListener(evt, wake, { passive: true }));
  wake();
})();
