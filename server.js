const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const HOST = process.env.HOST || "0.0.0.0";
const PORT = Number(process.env.PORT || 8000);
const DATA_FILE = path.join(__dirname, "queue-state.json");
const HISTORY_LIMIT = 20;
const EMERGENCY_PREFIX = "طوارئ";
const clients = new Set();
let state = null;
let writeChain = Promise.resolve();
let actionChain = Promise.resolve();

const uid = () => Date.now().toString(36) + crypto.randomBytes(4).toString("hex");
const nowIso = () => new Date().toISOString();
const isActive = (patient) => patient.status === "waiting" || patient.status === "called";
const formatNumber = (type, number) => (type === "emergency" ? EMERGENCY_PREFIX : "") + number;
const defaultState = () => ({
  patients: [],
  currentPatientId: null,
  nextNormalNumber: 1,
  nextEmergencyNumber: 1,
  lastAction: null,
  lastActionId: null
});

function normalize(raw) {
  const result = defaultState();
  if (!raw || typeof raw !== "object") return result;
  if (Array.isArray(raw.patients)) {
    result.patients = raw.patients.filter((patient) =>
      patient && patient.id && patient.name && patient.number &&
      (patient.type === "normal" || patient.type === "emergency")
    ).map((patient) => {
      if (patient.type === "emergency" && /^E\d+$/i.test(String(patient.number))) {
        return Object.assign({}, patient, { number: formatNumber("emergency", String(patient.number).slice(1)) });
      }
      return patient;
    });
  }
  const number = (value) => Math.max(1, parseInt(value, 10) || 1);
  result.nextNormalNumber = number(raw.nextNormalNumber);
  result.nextEmergencyNumber = number(raw.nextEmergencyNumber);
  result.lastAction = raw.lastAction || null;
  result.lastActionId = raw.lastActionId || null;
  const current = result.patients.find((patient) =>
    patient.id === raw.currentPatientId && patient.status === "called"
  );
  result.currentPatientId = current ? current.id : null;
  return result;
}

async function loadState() {
  try {
    const raw = await fs.promises.readFile(DATA_FILE, "utf8");
    return normalize(JSON.parse(raw));
  } catch (error) {
    if (error.code !== "ENOENT") console.error("Could not read queue-state.json:", error.message);
    return defaultState();
  }
}

function saveState(nextState) {
  writeChain = writeChain.then(async () => {
    const temporary = DATA_FILE + ".tmp";
    await fs.promises.writeFile(temporary, JSON.stringify(nextState, null, 2) + "\n", "utf8");
    await fs.promises.rename(temporary, DATA_FILE);
  });
  return writeChain;
}

function prune(nextState) {
  const finished = nextState.patients.filter((patient) => !isActive(patient));
  if (finished.length <= HISTORY_LIMIT) return;
  finished.sort((a, b) => String(a.finishedAt).localeCompare(String(b.finishedAt)));
  const removed = new Set(finished.slice(0, finished.length - HISTORY_LIMIT).map((patient) => patient.id));
  nextState.patients = nextState.patients.filter((patient) => !removed.has(patient.id));
}

function fail(message) {
  const error = new Error(message);
  error.statusCode = 400;
  throw error;
}

function currentPatient(nextState) {
  return nextState.patients.find((patient) => patient.id === nextState.currentPatientId) || null;
}

function numberInUse(nextState, number) {
  return nextState.patients.some((patient) => isActive(patient) && patient.number === number);
}

function suggestNumber(nextState, type) {
  let number = type === "emergency" ? nextState.nextEmergencyNumber : nextState.nextNormalNumber;
  while (numberInUse(nextState, formatNumber(type, number))) number++;
  return number;
}

function finish(patient, status) {
  patient.status = status;
  patient.finishedAt = nowIso();
}

function callPatient(nextState, patient) {
  patient.status = "called";
  patient.calledAt = nowIso();
  nextState.currentPatientId = patient.id;
}

function nextWaiting(nextState) {
  return nextState.patients.find((patient) => patient.status === "waiting") || null;
}

function applyAction(action, payload) {
  const nextState = normalize(state);
  let affected = null;

  if (action === "ADD") {
    const name = String(payload.name || "").replace(/\s+/g, " ").trim();
    const type = payload.type;
    if (!name) fail("يرجى إدخال اسم المريض");
    if (type !== "normal" && type !== "emergency") fail("نوع الدور غير صحيح");
    const suggested = suggestNumber(nextState, type);
    let number = suggested;
    let raw = String(payload.number || "").trim().toUpperCase();
    if (type === "emergency") raw = raw.replace(new RegExp("^" + EMERGENCY_PREFIX, "i"), "").replace(/^E/i, "");
    if (raw) {
      if (!/^\d{1,4}$/.test(raw) || parseInt(raw, 10) < 1) fail("رقم الدور غير صالح");
      number = parseInt(raw, 10);
    }
    const formatted = formatNumber(type, number);
    if (numberInUse(nextState, formatted)) fail("رقم الدور " + formatted + " مستخدم بالفعل لمريض آخر");
    affected = {
      id: uid(), name, type, number: formatted, status: "waiting",
      createdAt: nowIso(), calledAt: null, finishedAt: null
    };
    nextState.patients.push(affected);
    if (number === suggested) nextState[type === "emergency" ? "nextEmergencyNumber" : "nextNormalNumber"] = number + 1;
  } else if (action === "REMOVE") {
    affected = nextState.patients.find((patient) => patient.id === payload.id);
    if (!affected) fail("هذا المريض غير موجود");
    nextState.patients = nextState.patients.filter((patient) => patient.id !== payload.id);
    if (nextState.currentPatientId === payload.id) nextState.currentPatientId = null;
  } else if (action === "CALL_NEXT") {
    affected = nextWaiting(nextState);
    if (!affected) fail("لا يوجد مرضى في قائمة الانتظار");
    const current = currentPatient(nextState);
    if (current) finish(current, "completed");
    callPatient(nextState, affected);
  } else if (action === "CALL_PATIENT") {
    affected = nextState.patients.find((patient) => patient.id === payload.id && patient.status === "waiting");
    if (!affected) fail("هذا المريض غير موجود في قائمة الانتظار");
    const current = currentPatient(nextState);
    if (current) finish(current, "completed");
    callPatient(nextState, affected);
    action = "CALL_NEXT";
  } else if (action === "REORDER") {
    const waitingIndexes = nextState.patients.reduce((indexes, patient, index) => {
      if (patient.status === "waiting") indexes.push(index);
      return indexes;
    }, []);
    const position = waitingIndexes.findIndex((index) => nextState.patients[index].id === payload.id);
    if (position < 0) fail("هذا المريض غير موجود في قائمة الانتظار");
    const targetPosition = payload.direction === "top" ? 0 :
      payload.direction === "bottom" ? waitingIndexes.length - 1 :
      position + (payload.direction === "up" ? -1 : payload.direction === "down" ? 1 : 0);
    if (targetPosition < 0 || targetPosition >= waitingIndexes.length || targetPosition === position) {
      fail("لا يمكن تغيير ترتيب هذا المريض أكثر");
    }
    [affected] = nextState.patients.splice(waitingIndexes[position], 1);
    const remaining = nextState.patients.reduce((indexes, patient, index) => {
      if (patient.status === "waiting") indexes.push(index);
      return indexes;
    }, []);
    const insertAt = targetPosition === remaining.length ? nextState.patients.length : remaining[targetPosition];
    nextState.patients.splice(insertAt, 0, affected);
  } else if (action === "RECALL") {
    affected = currentPatient(nextState);
    if (!affected) fail("لا يوجد مريض حالي لإعادة ندائه");
  } else if (action === "SKIP") {
    affected = currentPatient(nextState);
    if (!affected) fail("لا يوجد مريض حالي لتخطيه");
    finish(affected, "skipped");
    nextState.currentPatientId = null;
    const next = nextWaiting(nextState);
    if (next) callPatient(nextState, next);
  } else if (action === "COMPLETE") {
    affected = currentPatient(nextState);
    if (!affected) fail("لا يوجد مريض حالي لإنهائه");
    finish(affected, "completed");
    nextState.currentPatientId = null;
  } else if (action === "RESET") {
    return defaultState();
  } else {
    fail("الأمر غير معروف");
  }

  nextState.lastAction = action;
  nextState.lastActionId = uid();
  prune(nextState);
  return nextState;
}

function sendJson(response, statusCode, value) {
  const body = JSON.stringify(value);
  response.writeHead(statusCode, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  response.end(body);
}

function broadcast(action, nextState) {
  const message = "data: " + JSON.stringify({ action, state: nextState, eventId: nextState.lastActionId }) + "\n\n";
  for (const response of clients) response.write(message);
}

async function readBody(request) {
  let body = "";
  for await (const chunk of request) body += chunk;
  if (body.length > 100000) throw new Error("الطلب كبير جدًا");
  return body ? JSON.parse(body) : {};
}

async function handle(request, response) {
  const url = new URL(request.url, "http://localhost");
  if (url.pathname === "/api/state" && request.method === "GET") return sendJson(response, 200, state);
  if (url.pathname === "/api/events" && request.method === "GET") {
    response.writeHead(200, { "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-cache", Connection: "keep-alive", "Access-Control-Allow-Origin": "*" });
    response.write("data: " + JSON.stringify({ action: "SYNC", state, eventId: state.lastActionId }) + "\n\n");
    clients.add(response);
    request.on("close", () => clients.delete(response));
    return;
  }
  if (url.pathname === "/api/action" && request.method === "POST") {
    actionChain = actionChain.then(async () => {
      try {
        const payload = await readBody(request);
        const action = payload.action;
        const nextState = applyAction(action, payload);
        await saveState(nextState);
        state = nextState;
        broadcast(nextState.lastAction, nextState);
        const patient = action === "ADD" ? nextState.patients[nextState.patients.length - 1] :
          action === "CALL_NEXT" ? currentPatient(nextState) :
          payload.id ? nextState.patients.find((item) => item.id === payload.id) || null : null;
        return sendJson(response, 200, { ok: true, state: nextState, patient: patient || null });
      } catch (error) {
        return sendJson(response, error.statusCode || 400, { ok: false, message: error.message || "تعذر تنفيذ العملية" });
      }
    });
    return actionChain;
  }
  return serveStatic(url.pathname, response);
}

function serveStatic(requestPath, response) {
  const relative = requestPath === "/" ? "index.html" : requestPath.slice(1);
  if (relative === "queue-state.json") return sendJson(response, 404, { message: "Not found" });
  const filePath = path.resolve(__dirname, relative);
  if (!filePath.startsWith(path.resolve(__dirname) + path.sep)) return sendJson(response, 403, { message: "Forbidden" });
  const types = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".json": "application/json; charset=utf-8" };
  fs.readFile(filePath, (error, content) => {
    if (error) return sendJson(response, error.code === "ENOENT" ? 404 : 500, { message: "Not found" });
    response.writeHead(200, { "Content-Type": types[path.extname(filePath)] || "application/octet-stream", "Cache-Control": "no-store" });
    response.end(content);
  });
}

(async () => {
  state = await loadState();
  await saveState(state);
  http.createServer((request, response) => handle(request, response).catch((error) => sendJson(response, 500, { message: error.message }))).listen(PORT, HOST, () => {
    console.log("Clinic queue server running at http://localhost:" + PORT);
    console.log("For other devices, open http://<this-computer-LAN-IP>:" + PORT + "/index.html");
    console.log("Queue data file: " + DATA_FILE);
  });
})();
