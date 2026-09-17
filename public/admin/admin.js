const $ = id => document.getElementById(id);
let csrfToken = null;

async function api(url, options = {}) {
  const headers = new Headers(options.headers || {});
  const method = String(options.method || 'GET').toUpperCase();

  if (csrfToken && !['GET', 'HEAD', 'OPTIONS'].includes(method)) {
    headers.set('X-CSRF-Token', csrfToken);
  }

  const response = await fetch(url, {
    ...options,
    headers,
    credentials: 'same-origin'
  });

  let data = {};
  try { data = await response.json(); } catch {}

  if (response.status === 401) {
    csrfToken = null;
    setAuthenticated(false);
  }

  if (!response.ok) throw new Error(data.message || 'A apărut o eroare.');
  if (data.csrfToken) csrfToken = data.csrfToken;
  return data;
}

function setAuthenticated(authenticated) {
  $('loginCard').classList.toggle('hidden', authenticated);
  $('dashboard').classList.toggle('hidden', !authenticated);
  $('logoutBtn').classList.toggle('hidden', !authenticated);
  if (authenticated) loadQuestions();
}

function gradeLabel(min, max) {
  const r = ['I', 'II', 'III', 'IV'];
  return min === max ? `Clasa ${r[min - 1]}` : `Clasele ${r[min - 1]}–${r[max - 1]}`;
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>'"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[c]));
}

async function loadQuestions() {
  const data = await api('/api/admin/questions');
  $('questionCount').textContent = data.questions.length;
  const list = $('questionsList');
  if (!data.questions.length) {
    list.innerHTML = '<div class="empty">📚 Nu ai adăugat încă întrebări.<br>Prima întrebare va apărea aici.</div>';
    return;
  }
  list.innerHTML = data.questions.map(q => `
    <article class="question-item">
      <div class="question-item-top">
        <div>
          <h3>${escapeHtml(q.text)}</h3>
          <div class="meta"><span class="chip">${escapeHtml(q.kind)}</span><span class="chip">${gradeLabel(q.minGrade, q.maxGrade)}</span></div>
        </div>
        <button class="delete-btn" data-delete="${escapeHtml(q.id)}" title="Șterge">🗑️</button>
      </div>
      ${q.image ? `<img class="question-thumb" src="${escapeHtml(q.image)}" alt="${escapeHtml(q.imageAlt || '')}">` : ''}
      <p class="correct">✅ ${escapeHtml(q.correct)}</p>
    </article>`).join('');
}

$('loginForm').addEventListener('submit', async event => {
  event.preventDefault();
  $('loginError').textContent = '';
  const button = event.currentTarget.querySelector('button[type="submit"]');
  button.disabled = true;
  try {
    const data = await api('/api/admin/login', {
      method: 'POST',
      headers: {'Content-Type':'application/json'},
      body: JSON.stringify({ password: $('password').value })
    });
    csrfToken = data.csrfToken;
    $('password').value = '';
    setAuthenticated(true);
  } catch (error) {
    $('loginError').textContent = error.message;
  } finally {
    button.disabled = false;
  }
});

$('logoutBtn').addEventListener('click', async () => {
  try {
    await api('/api/admin/logout', { method: 'POST' });
  } finally {
    csrfToken = null;
    setAuthenticated(false);
  }
});

$('questionForm').addEventListener('submit', async event => {
  event.preventDefault();
  const message = $('formMessage');
  const submit = event.currentTarget.querySelector('button[type="submit"]');
  message.className = 'message';
  message.textContent = 'Se salvează...';
  submit.disabled = true;

  try {
    const data = new FormData(event.currentTarget);
    await api('/api/admin/questions', { method: 'POST', body: data });
    event.currentTarget.reset();
    $('kind').value = 'Cultură generală';
    $('maxGrade').value = '4';
    $('imagePreviewWrap').classList.add('hidden');
    message.className = 'message success';
    message.textContent = '✅ Întrebarea a fost salvată și poate apărea imediat în joc.';
    await loadQuestions();
  } catch (error) {
    message.className = 'message error';
    message.textContent = error.message;
  } finally {
    submit.disabled = false;
  }
});

$('image').addEventListener('change', event => {
  const file = event.target.files?.[0];
  if (!file) return $('imagePreviewWrap').classList.add('hidden');

  const allowed = ['image/png', 'image/jpeg', 'image/webp'];
  if (!allowed.includes(file.type) || file.size > 4 * 1024 * 1024) {
    event.target.value = '';
    $('imagePreviewWrap').classList.add('hidden');
    $('formMessage').className = 'message error';
    $('formMessage').textContent = 'Imaginea trebuie să fie PNG, JPG/JPEG sau WEBP și să aibă maximum 4 MB.';
    return;
  }

  $('imagePreview').src = URL.createObjectURL(file);
  $('imagePreviewWrap').classList.remove('hidden');
});

$('questionsList').addEventListener('click', async event => {
  const button = event.target.closest('[data-delete]');
  if (!button) return;
  if (!confirm('Ștergi această întrebare?')) return;
  button.disabled = true;
  try {
    await api(`/api/admin/questions/${encodeURIComponent(button.dataset.delete)}`, { method: 'DELETE' });
    await loadQuestions();
  } catch (error) {
    alert(error.message);
    button.disabled = false;
  }
});

(async () => {
  try {
    const data = await api('/api/admin/me');
    csrfToken = data.csrfToken || null;
    setAuthenticated(data.authenticated);
  } catch {
    csrfToken = null;
    setAuthenticated(false);
  }
})();
