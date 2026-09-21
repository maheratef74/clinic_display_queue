/* ==========================================================
   control.js — صفحة التحكم (الاستقبال / الطبيب)
   المنطق كله في queue.js؛ هذا الملف للواجهة فقط.
   أسماء المرضى تُدرج دائمًا بـ textContent (لا innerHTML).
   ========================================================== */
(function () {
  "use strict";

  const CFG = window.CLINIC_CONFIG || {};
  const $ = (id) => document.getElementById(id);

  const TYPE_LABEL = { normal: "عادي", emergency: "طوارئ" };
  const STATUS_LABEL = { waiting: "في الانتظار", called: "يتم النداء", skipped: "تم التخطي", completed: "مكتمل" };

  const form = $("patientForm");
  const nameInput = $("nameInput");
  const numberInput = $("numberInput");
  const numberPrefix = $("numberPrefix");
  const currentPanel = $("currentPanel");
  let numberTouched = false; // هل عدّل المستخدم الرقم يدويًا؟

  function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }

  function fmtTime(iso) {
    const d = new Date(iso);
    return iso && !isNaN(d) ? d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" }) : "";
  }

  // ---------- إشعارات صغيرة ----------
  function toast(message, kind) {
    const box = $("toasts");
    const t = el("div", "toast " + (kind || ""), message);
    box.appendChild(t);
    while (box.children.length > 3) box.removeChild(box.firstChild);
    setTimeout(() => t.classList.add("hide"), 2800);
    setTimeout(() => { if (t.parentNode) t.parentNode.removeChild(t); }, 3200);
  }

  // ---------- نافذة تأكيد (بدل confirm) ----------
  function confirmDialog(message, okText) {
    return new Promise((resolve) => {
      const overlay = $("confirmOverlay");
      const ok = $("confirmOk");
      const cancel = $("confirmCancel");
      $("confirmMsg").textContent = message;
      ok.textContent = okText || "تأكيد";
      overlay.hidden = false;
      cancel.focus(); // الإلغاء هو الافتراضي لأن العملية مدمّرة

      function done(value) {
        overlay.hidden = true;
        ok.onclick = cancel.onclick = overlay.onclick = null;
        document.removeEventListener("keydown", onKey);
        resolve(value);
      }
      function onKey(e) { if (e.key === "Escape") done(false); }
      ok.onclick = () => done(true);
      cancel.onclick = () => done(false);
      overlay.onclick = (e) => { if (e.target === overlay) done(false); };
      document.addEventListener("keydown", onKey);
    });
  }

  // ---------- العرض ----------
  function currentType() { return form.elements.type.value; }

  function refreshNumberField(state) {
    const type = currentType();
    numberPrefix.hidden = type !== "emergency";
    if (!numberTouched) numberInput.value = Queue.suggestNumber(state, type);
  }

  function buildRow(p, current, mode) {
    const li = el("li", "row" + (p.id === current ? " is-current" : ""));
    const num = el("span", "num" + (p.type === "emergency" ? " emerg" : ""), p.number);
    num.dir = "ltr";
    li.appendChild(num);
    li.appendChild(el("span", "who", p.name));
    li.appendChild(el("span", "tag" + (p.type === "emergency" ? " tag-emerg" : ""), TYPE_LABEL[p.type]));
    li.appendChild(el("span", "tag st-" + p.status, STATUS_LABEL[p.status]));

    if (mode === "history") {
      const time = el("span", "time", fmtTime(p.finishedAt));
      time.dir = "ltr";
      li.appendChild(time);
    } else {
      if (p.status === "waiting") {
        const controls = el("span", "row-controls");
        const up = el("button", "btn-row", "↑");
        up.type = "button";
        up.title = "تقديم المريض";
        up.setAttribute("aria-label", "تقديم " + p.name);
        up.onclick = () => apply(Queue.movePatient(p.id, "up"));
        const down = el("button", "btn-row", "↓");
        down.type = "button";
        down.title = "تأخير المريض";
        down.setAttribute("aria-label", "تأخير " + p.name);
        down.onclick = () => apply(Queue.movePatient(p.id, "down"));
        const top = el("button", "btn-row btn-row-wide", "أولاً");
        top.type = "button";
        top.title = "نقل المريض إلى أول قائمة الانتظار";
        top.setAttribute("aria-label", "نقل " + p.name + " إلى أول القائمة");
        top.onclick = () => apply(Queue.movePatient(p.id, "top"));
        const bottom = el("button", "btn-row btn-row-wide", "أخيراً");
        bottom.type = "button";
        bottom.title = "نقل المريض إلى آخر قائمة الانتظار";
        bottom.setAttribute("aria-label", "نقل " + p.name + " إلى آخر القائمة");
        bottom.onclick = () => apply(Queue.movePatient(p.id, "bottom"));
        const call = el("button", "btn-call-row", "نداء الآن");
        call.type = "button";
        call.onclick = () => apply(Queue.callPatientById(p.id), "تم نداء " + p.number + " — " + p.name);
        controls.appendChild(up);
        controls.appendChild(down);
        controls.appendChild(top);
        controls.appendChild(bottom);
        controls.appendChild(call);
        li.appendChild(controls);
      }
      const del = el("button", "btn-del", "حذف");
      del.type = "button";
      del.setAttribute("aria-label", "حذف " + p.name);
      del.onclick = () => removeWithConfirm(p);
      li.appendChild(del);
    }
    return li;
  }

  function fillList(ul, items, emptyText) {
    ul.textContent = "";
    if (!items.length) ul.appendChild(el("li", "empty", emptyText));
    items.forEach((li) => ul.appendChild(li));
  }

  function render(state) {
    const cur = Queue.currentPatient(state);
    const active = state.patients.filter(Queue.isActive);
    const waitingCount = active.filter((p) => p.status === "waiting").length;

    // المريض الحالي
    currentPanel.dataset.type = cur ? cur.type : "none";
    $("curNumber").textContent = cur ? cur.number : "—";
    $("curName").textContent = cur ? cur.name : "لا يوجد مريض حالي";
    $("curName").classList.toggle("is-empty", !cur);
    $("btnNext").classList.toggle("is-idle", waitingCount === 0);
    ["btnRecall", "btnSkip", "btnComplete"].forEach((id) => $(id).classList.toggle("is-idle", !cur));

    // قائمة الانتظار (بترتيب الإضافة)
    $("waitingCount").textContent = waitingCount;
    fillList($("waitingList"), active.map((p) => buildRow(p, state.currentPatientId, "waiting")), "لا يوجد مرضى في الانتظار");

    // السجل: الأحدث أولًا
    const history = state.patients
      .filter((p) => !Queue.isActive(p))
      .sort((a, b) => String(b.finishedAt).localeCompare(String(a.finishedAt)))
      .map((p) => buildRow(p, null, "history"));
    fillList($("historyList"), history, "السجل فارغ");

    refreshNumberField(state);
  }

  // يعرض نتيجة العملية ويحدّث الشاشة (BroadcastChannel لا يعيد الرسالة لنفس الصفحة)
  async function apply(result, successMessage) {
    result = await result;
    if (!result.ok) { toast(result.message, "error"); return false; }
    if (result.saved === false) toast("تعذّر حفظ البيانات في المتصفح، قد تضيع عند التحديث", "error");
    render(result.state);
    if (successMessage) toast(successMessage, "success");
    return true;
  }

  // ---------- الأحداث ----------
  form.addEventListener("submit", async function (e) {
    e.preventDefault();
    const r = await Queue.addPatient(nameInput.value, currentType(), numberInput.value);
    if (!r.ok) {
      toast(r.message, "error");
      nameInput.setAttribute("aria-invalid", r.field === "name" ? "true" : "false");
      const target = r.field === "name" ? nameInput : numberInput;
      target.focus();
      if (target === numberInput) numberInput.select();
      return;
    }
    nameInput.removeAttribute("aria-invalid");
    nameInput.value = "";
    numberTouched = false;
    apply(r, "تمت إضافة " + r.patient.name + " برقم " + r.patient.number);
    nameInput.focus();
  });

  Array.prototype.forEach.call(form.elements.type, function (radio) {
    radio.addEventListener("change", function () {
      numberTouched = false;
      Queue.load().then(refreshNumberField);
    });
  });

  numberInput.addEventListener("input", function () {
    numberTouched = true;
    numberInput.value = Queue.toLatinDigits(numberInput.value).replace(/\D/g, ""); // أرقام فقط (تقبل الأرقام العربية)
  });

  $("btnNext").addEventListener("click", async function () {
    const r = await Queue.callNext();
    apply(r, r.ok ? "تم نداء " + r.patient.number + " — " + r.patient.name : "");
  });

  $("btnRecall").addEventListener("click", async function () {
    const name = $("curName").textContent;
    const r = await Queue.recall();
    apply(r, r.ok ? "تمت إعادة نداء " + name : "");
  });

  $("btnSkip").addEventListener("click", async function () {
    const name = $("curName").textContent;
    const r = await Queue.skip();
    if (!r.ok) return apply(r);
    const next = Queue.currentPatient(r.state);
    apply(r, next
      ? "تم تخطي " + name + " ونداء " + next.number + " — " + next.name
      : "تم تخطي " + name + " ولا يوجد مرضى آخرون في الانتظار");
  });

  $("btnComplete").addEventListener("click", async function () {
    const name = $("curName").textContent;
    const r = await Queue.complete();
    apply(r, r.ok ? "تم إنهاء زيارة " + name : "");
  });

  function removeWithConfirm(p) {
    confirmDialog("حذف «" + p.name + "» (" + p.number + ") من الطابور؟", "حذف").then(function (yes) {
      if (yes) apply(Queue.removePatient(p.id), "تم حذف " + p.name);
    });
  }

  $("btnReset").addEventListener("click", function () {
    confirmDialog("هل أنت متأكد من إعادة تعيين جميع بيانات الانتظار؟", "نعم، أعد التعيين").then(function (yes) {
      if (!yes) return;
      numberTouched = false;
      apply(Queue.reset(), "تمت إعادة تعيين الطابور");
    });
  });

  // ---------- البدء ----------
  $("clinicName").textContent = CFG.clinicName || "";
  document.title = "نظام انتظار المرضى — " + (CFG.clinicName || "");
  $("syncMode").textContent = "الخادم + ملف JSON";

  Queue.load().then(render);
  Queue.subscribe(render); // تغييرات قادمة من نافذة تحكم أخرى
})();
