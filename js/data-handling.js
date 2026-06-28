/**
 * Meta App Review — Data handling questionnaire guide
 */
const DataHandling = (function () {
  'use strict';

  const LS = {
    entity: 'wayfair_data_controller',
    country: 'wayfair_data_country',
    processors: 'wayfair_data_processors',
  };

  function defaults() {
    const b = typeof APP_BRAND !== 'undefined' ? APP_BRAND : {};
    return {
      entity: b.legalEntity || 'Muhammad Faisal Rehman',
      country: b.dataControllerCountry || 'Pakistan',
      processors:
        b.processors ||
        'Railway Corporation — cloud hosting for our HTTPS web app and Messenger webhook endpoint. Railway may temporarily process server logs related to webhook delivery. We do not use additional analytics or advertising processors for Meta Platform Data.',
    };
  }

  function loadSaved() {
    const d = defaults();
    return {
      entity: localStorage.getItem(LS.entity) || d.entity,
      country: localStorage.getItem(LS.country) || d.country,
      processors: localStorage.getItem(LS.processors) || d.processors,
    };
  }

  function save(field, value) {
    localStorage.setItem(LS[field], value);
  }

  const QUESTIONS = [
    {
      id: 'processor-0',
      title: 'Data processors or service providers?',
      question:
        'Do you have data processors or service providers that will have access to the Platform Data that you obtain from Meta?',
      recommend: 'Yes',
      why: 'Aap ki app Railway par hosted hai — webhook aur server logs ke liye hosting provider ek processor hai. Agar sirf browser mein data dikhao aur koi server/third party na ho to "No" bhi possible hai — lekin Railway webhook use karte ho to "Yes" zyada accurate hai.',
      copyKey: 'processors',
      copyLabel: 'Processor names (paste in Meta if Yes)',
    },
    {
      id: 'responsible-1',
      title: 'Data controller (legal entity)',
      question: 'Who is the person or entity responsible for all Platform Data Meta shares with you?',
      recommend: 'Your legal name or registered business name',
      why: 'Jo person/company app ki malik hai — woh data controller hai. Individual developer ho to apna poora legal naam likho. Registered company ho to company ka naam.',
      copyKey: 'entity',
      copyLabel: 'Controller name',
    },
    {
      id: 'responsible-2',
      title: 'Controller country',
      question: 'Select the country where this person or entity is located.',
      recommend: 'Pakistan',
      why: 'Jis country mein aap legally resident / business registered ho — woh select karo.',
      copyKey: 'country',
      copyLabel: 'Country',
    },
    {
      id: 'requests-3',
      title: 'National security requests (past 12 months)',
      question:
        'Have you provided the personal data of users to public authorities in response to national security requests in the past 12 months?',
      recommend: 'No',
      why: 'Chhoti app / naya project — agar aap ne kabhi government ko user data nahi di to "No" select karo. Yeh search warrants / criminal court orders se alag hai.',
      copyKey: null,
    },
    {
      id: 'requests-4',
      title: 'Policies for public authority requests',
      question: 'Which policies or processes do you have in place? Check all that apply.',
      recommend: [
        'Required review of the legality of these requests',
        'Provisions for challenging these requests if they are considered unlawful',
        'Data minimization policy — disclose minimum information necessary',
        'Documentation of these requests',
      ],
      why: 'Meta expects responsible data practices. In char options check karo — yeh standard privacy posture hai aur reject hone ka risk kam hota hai.',
      copyKey: null,
      isCheckbox: true,
    },
  ];

  function render() {
    const root = document.getElementById('data-handling-root');
    if (!root) return;

    const saved = loadSaved();
    root.innerHTML = `
      <div class="data-handling-intro settings-block">
        <h3>Meta → App Review → Data handling</h3>
        <p class="meta-muted">Yeh questions har Advanced Access permission ke saath aate hain. Neeche recommended answers hain — Meta form mein step-by-step copy karo. Legal advice ke liye apne lawyer se consult karo.</p>
      </div>

      <div class="data-handling-fields settings-block">
        <h3>Your details (edit → auto-saved)</h3>
        <div class="creds-row">
          <label for="dh-entity">Data controller (legal name / business)</label>
          <input type="text" id="dh-entity" value="${escapeAttr(saved.entity)}" placeholder="Full legal name or company name" />
        </div>
        <div class="creds-row">
          <label for="dh-country">Country</label>
          <input type="text" id="dh-country" value="${escapeAttr(saved.country)}" placeholder="e.g. Pakistan" />
        </div>
        <div class="creds-row">
          <label for="dh-processors">Processor description (if Yes on Q1)</label>
          <textarea id="dh-processors" rows="3">${escape(saved.processors)}</textarea>
        </div>
      </div>

      ${QUESTIONS.map((q) => renderQuestion(q, saved)).join('')}

      <div class="settings-block data-handling-summary">
        <h3>Quick copy — full summary for your notes</h3>
        <pre class="code-block" id="data-handling-summary"></pre>
        <button type="button" id="btn-copy-data-summary" class="btn-primary">Copy full data handling summary</button>
      </div>`;

    bindInputs();
    updateSummary(saved);
    document.getElementById('btn-copy-data-summary')?.addEventListener('click', copySummary);
    root.querySelectorAll('[data-copy-dh]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const key = btn.getAttribute('data-copy-dh');
        const savedNow = loadSaved();
        const text = savedNow[key] || '';
        navigator.clipboard?.writeText(text);
        if (typeof toast === 'function') toast('Copied');
      });
    });
  }

  function renderQuestion(q, saved) {
    const rec = Array.isArray(q.recommend)
      ? `<ul class="dh-checklist">${q.recommend.map((r) => `<li>☑ ${escape(r)}</li>`).join('')}</ul>`
      : `<p class="dh-recommend"><strong>Select:</strong> <span class="dh-answer-pill">${escape(q.recommend)}</span></p>`;

    const copyBtn =
      q.copyKey && saved[q.copyKey]
        ? `<button type="button" class="btn-outline-sm btn-sm" data-copy-dh="${q.copyKey}">Copy ${escape(q.copyLabel || 'text')}</button>`
        : '';

    return `
      <article class="data-handling-card" id="dh-${q.id}">
        <span class="data-handling-id">${escape(q.id)}</span>
        <h4>${escape(q.title)}</h4>
        <p class="dh-question">${escape(q.question)}</p>
        ${rec}
        <p class="dh-why"><strong>Guide:</strong> ${escape(q.why)}</p>
        ${copyBtn}
      </article>`;
  }

  function bindInputs() {
    const map = [
      ['dh-entity', 'entity'],
      ['dh-country', 'country'],
      ['dh-processors', 'processors'],
    ];
    map.forEach(([id, key]) => {
      const el = document.getElementById(id);
      el?.addEventListener('input', () => {
        save(key, el.value);
        updateSummary(loadSaved());
      });
    });
  }

  function updateSummary(saved) {
    const el = document.getElementById('data-handling-summary');
    if (!el) return;
    const app = (typeof APP_BRAND !== 'undefined' && APP_BRAND.name) || 'Wayfair';
    el.textContent = `${app} — META DATA HANDLING ANSWERS
================================

Q1 (processor-0): YES — we use a hosting provider.
Processors: ${saved.processors}

Q2 (responsible-1): Data controller
${saved.entity}

Q3 (responsible-2): Country
${saved.country}

Q4 (requests-3): NO — we have not shared user personal data with public authorities for national security requests in the past 12 months.

Q5 (requests-4): CHECK ALL:
☑ Required review of the legality of these requests
☑ Provisions for challenging unlawful requests
☑ Data minimization policy
☑ Documentation of requests

Privacy policy: ${location.origin}/privacy.html
Data deletion: ${location.origin}/data-deletion.html
Contact: ${(typeof APP_BRAND !== 'undefined' && APP_BRAND.contactEmail) || 'alirunyonali@gmail.com'}`;
  }

  function copySummary() {
    const text = document.getElementById('data-handling-summary')?.textContent || '';
    navigator.clipboard?.writeText(text);
    if (typeof toast === 'function') toast('Data handling summary copied');
  }

  function escape(s) {
    const d = document.createElement('div');
    d.textContent = s ?? '';
    return d.innerHTML;
  }

  function escapeAttr(s) {
    return String(s ?? '').replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
  }

  return { render, loadSaved };
})();
