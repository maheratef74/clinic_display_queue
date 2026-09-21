/* ==========================================================
   queue.js — الحالة + التخزين المحلي + المزامنة بين الصفحات
   ========================================================== */
const Queue = (function () {
  "use strict";

  const CFG = window.CLINIC_CONFIG || {};
  const STORAGE_KEY = "clinic_queue_state_v1";
  const CHANNEL_NAME = "clinic_queue_channel";
  const HISTORY_LIMIT = CFG.historyLimit > 0 ? CFG.historyLimit : 20;
  const EMERGENCY_PREFIX = String(CFG.emergencyPrefix || "طوارئ");
  let memoryState = null;
  let channel = null;

  if (!CFG.forceStorageFallback && typeof window.BroadcastChannel === "function") {
    try { channel = new BroadcastChannel(CHANNEL_NAME); } catch (error) { channel = null; }
  }

  const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  const nowIso = () => new Date().toISOString();
  const isActive = (patient) => patient.status === "waiting" || patient.status === "called";
  const formatNumber = (type, number) => (type === "emergency" ? EMERGENCY_PREFIX : "") + number;
  const toLatinDigits = (value) => String(value == null ? "" : value)
    .replace(/[٠-٩]/g, (digit) => digit.charCodeAt(0) - 0x0660)
    .replace(/[۰-۹]/g, (digit) => digit.charCodeAt(0) - 0x06f0);
  const fail = (message, field) => ({ ok: false, message: message, field: field || null });

  function defaultState() {
    return { patients: [], currentPatientId: null, nextNormalNumber: 1, nextEmergencyNumber: 1, lastAction: null, lastActionId: null };
  }

  function normalize(raw) {
    const state = defaultState();
    if (!raw || typeof raw !== "object") return state;
    if (Array.isArray(raw.patients)) {
      state.patients = raw.patients.filter((patient) =>
        patient && patient.id && patient.name && patient.number && (patient.type === "normal" || patient.type === "emergency")
      ).map((patient) => /^E\d+$/i.test(String(patient.number)) && patient.type === "emergency"
        ? Object.assign({}, patient, { number: formatNumber("emergency", String(patient.number).slice(1)) }) : patient);
    }
    const number = (value) => Math.max(1, parseInt(value, 10) || 1);
    state.nextNormalNumber = number(raw.nextNormalNumber);
    state.nextEmergencyNumber = number(raw.nextEmergencyNumber);
    state.lastAction = raw.lastAction || null;
    state.lastActionId = raw.lastActionId || null;
    const current = state.patients.find((patient) => patient.id === raw.currentPatientId && patient.status === "called");
    state.currentPatientId = current ? current.id : null;
    return state;
  }

  function load() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      return normalize(raw ? JSON.parse(raw) : memoryState);
    } catch (error) {
      return normalize(memoryState);
    }
  }

  function save(state) {
    memoryState = state;
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); return true; }
    catch (error) { return false; }
  }

  function commit(state, action, patient) {
    state.lastAction = action;
    state.lastActionId = uid();
    const finished = state.patients.filter((item) => !isActive(item));
    if (finished.length > HISTORY_LIMIT) {
      finished.sort((a, b) => String(a.finishedAt).localeCompare(String(b.finishedAt)));
      const remove = new Set(finished.slice(0, finished.length - HISTORY_LIMIT).map((item) => item.id));
      state.patients = state.patients.filter((item) => !remove.has(item.id));
    }
    const saved = save(state);
    if (channel) channel.postMessage({ type: "QUEUE_UPDATED", action: action, state: state, eventId: state.lastActionId });
    return { ok: true, state: state, saved: saved, patient: patient || null };
  }

  function subscribe(callback) {
    if (channel) channel.addEventListener("message", (event) => {
      const message = event.data;
      if (message && message.type === "QUEUE_UPDATED" && message.state) callback(normalize(message.state), message.action, message.eventId);
    });
    else window.addEventListener("storage", (event) => {
      if (event.key === null || event.key === STORAGE_KEY) { const state = load(); callback(state, state.lastAction, state.lastActionId); }
    });
  }

  const currentPatient = (state) => state.patients.find((patient) => patient.id === state.currentPatientId) || null;
  const nextWaiting = (state) => state.patients.find((patient) => patient.status === "waiting") || null;
  const numberInUse = (state, number) => state.patients.some((patient) => isActive(patient) && patient.number === number);

  function suggestNumber(state, type) {
    let number = type === "emergency" ? state.nextEmergencyNumber : state.nextNormalNumber;
    while (numberInUse(state, formatNumber(type, number))) number++;
    return number;
  }

  function finish(patient, status) { patient.status = status; patient.finishedAt = nowIso(); }
  function callPatient(state, patient) { patient.status = "called"; patient.calledAt = nowIso(); state.currentPatientId = patient.id; }

  function addPatient(name, type, numberInput) {
    name = String(name || "").replace(/\s+/g, " ").trim();
    if (!name) return fail("يرجى إدخال اسم المريض", "name");
    if (type !== "normal" && type !== "emergency") return fail("نوع الدور غير صحيح", "type");
    const state = load();
    const suggested = suggestNumber(state, type);
    let number = suggested;
    let raw = toLatinDigits(numberInput).trim().toUpperCase();
    if (type === "emergency") raw = raw.replace(new RegExp("^" + EMERGENCY_PREFIX, "i"), "").replace(/^E/i, "");
    if (raw && (!/^\d{1,4}$/.test(raw) || parseInt(raw, 10) < 1)) return fail("رقم الدور غير صالح", "number");
    if (raw) number = parseInt(raw, 10);
    const formatted = formatNumber(type, number);
    if (numberInUse(state, formatted)) return fail("رقم الدور " + formatted + " مستخدم بالفعل لمريض آخر", "number");
    const patient = { id: uid(), name: name, type: type, number: formatted, status: "waiting", createdAt: nowIso(), calledAt: null, finishedAt: null };
    state.patients.push(patient);
    if (number === suggested) state[type === "emergency" ? "nextEmergencyNumber" : "nextNormalNumber"] = number + 1;
    return commit(state, "ADD", patient);
  }

  function removePatient(id) {
    const state = load(); const patient = state.patients.find((item) => item.id === id);
    if (!patient) return fail("هذا المريض غير موجود");
    state.patients = state.patients.filter((item) => item.id !== id);
    if (state.currentPatientId === id) state.currentPatientId = null;
    return commit(state, "REMOVE", patient);
  }

  function callNext() {
    const state = load(); const next = nextWaiting(state);
    if (!next) return fail("لا يوجد مرضى في قائمة الانتظار");
    const current = currentPatient(state); if (current) finish(current, "completed");
    callPatient(state, next); return commit(state, "CALL_NEXT", next);
  }

  function callPatientById(id) {
    const state = load(); const next = state.patients.find((item) => item.id === id && item.status === "waiting");
    if (!next) return fail("هذا المريض غير موجود في قائمة الانتظار");
    const current = currentPatient(state); if (current) finish(current, "completed");
    callPatient(state, next); return commit(state, "CALL_NEXT", next);
  }

  function movePatient(id, direction) {
    const state = load();
    const indexes = state.patients.reduce((list, patient, index) => { if (patient.status === "waiting") list.push(index); return list; }, []);
    const position = indexes.findIndex((index) => state.patients[index].id === id);
    if (position < 0) return fail("هذا المريض غير موجود في قائمة الانتظار");
    const target = direction === "top" ? 0 : direction === "bottom" ? indexes.length - 1 : position + (direction === "up" ? -1 : 1);
    if (target < 0 || target >= indexes.length || target === position) return fail("لا يمكن تغيير ترتيب هذا المريض أكثر");
    const moved = state.patients.splice(indexes[position], 1)[0];
    const remaining = state.patients.reduce((list, patient, index) => { if (patient.status === "waiting") list.push(index); return list; }, []);
    state.patients.splice(target === remaining.length ? state.patients.length : remaining[target], 0, moved);
    return commit(state, "REORDER", moved);
  }

  function recall() { const state = load(); const patient = currentPatient(state); if (!patient) return fail("لا يوجد مريض حالي لإعادة ندائه"); return commit(state, "RECALL", patient); }
  function skip() { const state = load(); const patient = currentPatient(state); if (!patient) return fail("لا يوجد مريض حالي لتخطيه"); finish(patient, "skipped"); state.currentPatientId = null; const next = nextWaiting(state); if (next) callPatient(state, next); return commit(state, "SKIP", patient); }
  function complete() { const state = load(); const patient = currentPatient(state); if (!patient) return fail("لا يوجد مريض حالي لإنهائه"); finish(patient, "completed"); state.currentPatientId = null; return commit(state, "COMPLETE", patient); }
  function reset() { return commit(defaultState(), "RESET"); }

  return { syncMode: channel ? "broadcast" : "storage", load, subscribe, currentPatient, isActive, suggestNumber, toLatinDigits, addPatient, removePatient, callNext, callPatientById, movePatient, recall, skip, complete, reset };
})();
