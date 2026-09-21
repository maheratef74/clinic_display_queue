/* ==========================================================
   queue.js — واجهة المتصفح للحالة المشتركة على الخادم
   ========================================================== */
const Queue = (function () {
  "use strict";

  const CFG = window.CLINIC_CONFIG || {};
  const EMERGENCY_PREFIX = String(CFG.emergencyPrefix || "طوارئ");
  let cachedState = null;

  const fail = (message) => ({ ok: false, message: message, field: null });
  const formatNumber = (type, number) => (type === "emergency" ? EMERGENCY_PREFIX : "") + number;
  const toLatinDigits = (value) => String(value == null ? "" : value)
    .replace(/[٠-٩]/g, (digit) => digit.charCodeAt(0) - 0x0660)
    .replace(/[۰-۹]/g, (digit) => digit.charCodeAt(0) - 0x06f0);
  const isActive = (patient) => patient.status === "waiting" || patient.status === "called";
  const currentPatient = (state) => state.patients.filter((patient) => patient.id === state.currentPatientId)[0] || null;

  async function request(action, data) {
    try {
      const response = await fetch("/api/action", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(Object.assign({ action: action }, data || {}))
      });
      const result = await response.json();
      if (!response.ok || !result.ok) return fail(result.message || "تعذر تنفيذ العملية");
      cachedState = result.state;
      return result;
    } catch (error) {
      return fail("تعذر الاتصال بالخادم");
    }
  }

  async function load() {
    try {
      const response = await fetch("/api/state", { cache: "no-store" });
      if (!response.ok) throw new Error("state");
      cachedState = await response.json();
      return cachedState;
    } catch (error) {
      return cachedState || { patients: [], currentPatientId: null, nextNormalNumber: 1, nextEmergencyNumber: 1, lastAction: null, lastActionId: null };
    }
  }

  function suggestNumber(state, type) {
    let number = type === "emergency" ? state.nextEmergencyNumber : state.nextNormalNumber;
    while (state.patients.some((patient) => isActive(patient) && patient.number === formatNumber(type, number))) number++;
    return number;
  }

  function subscribe(callback) {
    const events = new EventSource("/api/events");
    events.onmessage = (event) => {
      try {
        const message = JSON.parse(event.data);
        cachedState = message.state;
        callback(message.state, message.action, message.eventId);
      } catch (error) { /* تجاهل رسالة غير صالحة */ }
    };
    return events;
  }

  return {
    syncMode: "server",
    load: load,
    subscribe: subscribe,
    currentPatient: currentPatient,
    isActive: isActive,
    suggestNumber: suggestNumber,
    toLatinDigits: toLatinDigits,
    addPatient: (name, type, number) => request("ADD", { name: name, type: type, number: number }),
    removePatient: (id) => request("REMOVE", { id: id }),
    callNext: () => request("CALL_NEXT"),
    callPatientById: (id) => request("CALL_PATIENT", { id: id }),
    movePatient: (id, direction) => request("REORDER", { id: id, direction: direction }),
    recall: () => request("RECALL"),
    skip: () => request("SKIP"),
    complete: () => request("COMPLETE"),
    reset: () => request("RESET")
  };
})();
