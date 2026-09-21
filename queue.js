/* ==========================================================
   queue.js — الحالة + التخزين + المزامنة (مشترك بين الصفحتين)

   - localStorage     : المصدر الدائم للحالة
   - BroadcastChannel : إشعار فوري للصفحة الأخرى
   - storage event    : بديل تلقائي إذا لم تتوفر BroadcastChannel

   كل عملية: تحميل الحالة ← تعديلها ← حفظها ← بثّها.
   ========================================================== */
const Queue = (function () {
  "use strict";

  const CFG = window.CLINIC_CONFIG || {};
  const STORAGE_KEY = "clinic_queue_state_v1";
  const CHANNEL_NAME = "clinic_queue_channel";
  const HISTORY_LIMIT = CFG.historyLimit > 0 ? CFG.historyLimit : 20;

  let memoryState = null; // نسخة احتياطية إن تعذّر استخدام localStorage

  // ---------- قناة الاتصال ----------
  let channel = null;
  if (!CFG.forceStorageFallback && typeof window.BroadcastChannel === "function") {
    try { channel = new BroadcastChannel(CHANNEL_NAME); } catch (e) { channel = null; }
  }
  const syncMode = channel ? "broadcast" : "storage";

  // ---------- أدوات صغيرة ----------
  const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  const nowIso = () => new Date().toISOString();
  const isActive = (p) => p.status === "waiting" || p.status === "called";
  const fail = (message, field) => ({ ok: false, message: message, field: field || null });
  const formatNumber = (type, n) => (type === "emergency" ? "E" : "") + n;
  const toLatinDigits = (v) =>
    String(v == null ? "" : v)
      .replace(/[\u0660-\u0669]/g, (d) => d.charCodeAt(0) - 0x0660) // ٠-٩
      .replace(/[\u06F0-\u06F9]/g, (d) => d.charCodeAt(0) - 0x06f0); // ۰-۹

  // ---------- نموذج الحالة ----------
  function defaultState() {
    return {
      patients: [],
      currentPatientId: null,
      nextNormalNumber: 1,
      nextEmergencyNumber: 1,
      lastAction: null,
      lastActionId: null
    };
  }

  // يضمن أن أي بيانات قادمة من التخزين/القناة سليمة الشكل
  function normalize(raw) {
    const s = defaultState();
    if (!raw || typeof raw !== "object") return s;
    if (Array.isArray(raw.patients)) {
      s.patients = raw.patients.filter(
        (p) => p && p.id && p.name && p.number && (p.type === "normal" || p.type === "emergency")
      );
    }
    const num = (v) => Math.max(1, parseInt(v, 10) || 1);
    s.nextNormalNumber = num(raw.nextNormalNumber);
    s.nextEmergencyNumber = num(raw.nextEmergencyNumber);
    s.lastAction = raw.lastAction || null;
    s.lastActionId = raw.lastActionId || null;
    const cur = s.patients.filter((p) => p.id === raw.currentPatientId && p.status === "called")[0];
    s.currentPatientId = cur ? cur.id : null;
    return s;
  }

  // ---------- التخزين ----------
  function load() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      return normalize(raw ? JSON.parse(raw) : memoryState);
    } catch (e) {
      return normalize(memoryState);
    }
  }

  function save(state) {
    memoryState = state;
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
      return true;
    } catch (e) {
      return false;
    }
  }

  // الاحتفاظ بآخر N سجل فقط من (المنتهين + المتخطَّين)
  function prune(state) {
    const done = state.patients.filter((p) => !isActive(p));
    if (done.length <= HISTORY_LIMIT) return;
    done.sort((a, b) => String(a.finishedAt).localeCompare(String(b.finishedAt)));
    const drop = {};
    done.slice(0, done.length - HISTORY_LIMIT).forEach((p) => { drop[p.id] = true; });
    state.patients = state.patients.filter((p) => !drop[p.id]);
  }

  // حفظ + بثّ. كل تغيير يحصل على eventId جديد (تستخدمه شاشة العرض لتمييز النداء الجديد)
  function commit(state, action, patient) {
    state.lastAction = action;
    state.lastActionId = uid();
    prune(state);
    const saved = save(state);
    if (channel) {
      try {
        channel.postMessage({ type: "QUEUE_UPDATED", action: action, state: state, eventId: state.lastActionId });
      } catch (e) { /* تجاهل */ }
    }
    return { ok: true, state: state, saved: saved, patient: patient || null };
  }

  // callback(state, action, eventId) — يُستدعى عند تغيير من صفحة أخرى
  function subscribe(callback) {
    if (channel) {
      channel.addEventListener("message", function (e) {
        const m = e.data;
        if (m && m.type === "QUEUE_UPDATED" && m.state) callback(normalize(m.state), m.action, m.eventId);
      });
    } else {
      // بديل: حدث storage يصل فقط للصفحات الأخرى (وليس للصفحة التي كتبت)
      window.addEventListener("storage", function (e) {
        if (e.key !== null && e.key !== STORAGE_KEY) return;
        const s = load();
        callback(s, s.lastAction, s.lastActionId);
      });
    }
  }

  // ---------- مساعدات الطابور ----------
  const currentPatient = (s) => s.patients.filter((p) => p.id === s.currentPatientId)[0] || null;
  const nextWaiting = (s) => s.patients.filter((p) => p.status === "waiting")[0] || null; // بحسب ترتيب الإضافة
  const numberInUse = (s, number) => s.patients.some((p) => isActive(p) && p.number === number);

  // أول رقم متاح للنوع المطلوب (يتخطى أي رقم مستخدم حاليًا)
  function suggestNumber(s, type) {
    let n = type === "emergency" ? s.nextEmergencyNumber : s.nextNormalNumber;
    while (numberInUse(s, formatNumber(type, n))) n++;
    return n;
  }

  function finish(patient, status) {
    patient.status = status;
    patient.finishedAt = nowIso();
  }

  function callPatient(s, patient) {
    patient.status = "called";
    patient.calledAt = nowIso();
    s.currentPatientId = patient.id;
  }

  // ---------- العمليات ----------
  function addPatient(name, type, numberInput) {
    name = String(name || "").replace(/\s+/g, " ").trim();
    if (!name) return fail("يرجى إدخال اسم المريض", "name");
    if (type !== "normal" && type !== "emergency") return fail("نوع الدور غير صحيح", "type");

    const s = load();
    const suggested = suggestNumber(s, type);
    let n = suggested;

    let raw = toLatinDigits(numberInput).trim().toUpperCase();
    if (type === "emergency") raw = raw.replace(/^E/, "");
    if (raw !== "") {
      if (!/^\d{1,4}$/.test(raw) || parseInt(raw, 10) < 1) return fail("رقم الدور غير صالح", "number");
      n = parseInt(raw, 10);
    }

    const number = formatNumber(type, n);
    if (numberInUse(s, number)) return fail("رقم الدور " + number + " مستخدم بالفعل لمريض آخر", "number");

    const patient = {
      id: uid(),
      name: name,
      type: type,
      number: number,
      status: "waiting",
      createdAt: nowIso(),
      calledAt: null,
      finishedAt: null
    };
    s.patients.push(patient);
    if (n === suggested) s[type === "emergency" ? "nextEmergencyNumber" : "nextNormalNumber"] = n + 1;
    return commit(s, "ADD", patient);
  }

  function removePatient(id) {
    const s = load();
    const patient = s.patients.filter((p) => p.id === id)[0];
    if (!patient) return fail("هذا المريض غير موجود");
    s.patients = s.patients.filter((p) => p.id !== id);
    if (s.currentPatientId === id) s.currentPatientId = null;
    return commit(s, "REMOVE", patient);
  }

  function callNext() {
    const s = load();
    const next = nextWaiting(s);
    if (!next) return fail("لا يوجد مرضى في قائمة الانتظار");
    const cur = currentPatient(s);
    if (cur) finish(cur, "completed");
    callPatient(s, next);
    return commit(s, "CALL_NEXT", next);
  }

  function recall() {
    const s = load();
    const cur = currentPatient(s);
    if (!cur) return fail("لا يوجد مريض حالي لإعادة ندائه");
    return commit(s, "RECALL", cur); // نفس الحالة، حدث جديد فقط
  }

  function skip() {
    const s = load();
    const cur = currentPatient(s);
    if (!cur) return fail("لا يوجد مريض حالي لتخطيه");
    finish(cur, "skipped");
    s.currentPatientId = null;
    const next = nextWaiting(s);
    if (next) callPatient(s, next);
    return commit(s, "SKIP", cur);
  }

  function complete() {
    const s = load();
    const cur = currentPatient(s);
    if (!cur) return fail("لا يوجد مريض حالي لإنهائه");
    finish(cur, "completed");
    s.currentPatientId = null;
    return commit(s, "COMPLETE", cur);
  }

  function reset() {
    return commit(defaultState(), "RESET");
  }

  return {
    syncMode: syncMode,
    load: load,
    subscribe: subscribe,
    currentPatient: currentPatient,
    isActive: isActive,
    suggestNumber: suggestNumber,
    toLatinDigits: toLatinDigits,
    addPatient: addPatient,
    removePatient: removePatient,
    callNext: callNext,
    recall: recall,
    skip: skip,
    complete: complete,
    reset: reset
  };
})();
