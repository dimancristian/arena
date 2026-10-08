const socket = io();

const $ = id => document.getElementById(id);
const screens = ['homeScreen', 'lobbyScreen', 'gameScreen', 'finalScreen'];


// ------------------------------------------------------------
// Sunete UI - generate direct în browser cu Web Audio API.
// Nu sunt necesare fișiere MP3/WAV externe.
// ------------------------------------------------------------
const sound = {
  ctx: null,
  enabled: localStorage.getItem('mathArenaSound') !== 'off',
  unlocked: false,
  lastCountdownSecond: null,

  ensure() {
    if (!this.enabled) return null;
    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    if (!AudioCtx) return null;
    if (!this.ctx) this.ctx = new AudioCtx();
    if (this.ctx.state === 'suspended') this.ctx.resume().catch(() => {});
    this.unlocked = true;
    return this.ctx;
  },

  tone(freq, duration = 0.08, type = 'sine', volume = 0.045, delay = 0) {
    if (!this.enabled) return;
    const ctx = this.ensure();
    if (!ctx) return;
    const start = ctx.currentTime + delay;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, start);
    gain.gain.setValueAtTime(0.0001, start);
    gain.gain.exponentialRampToValueAtTime(Math.max(0.0002, volume), start + 0.008);
    gain.gain.exponentialRampToValueAtTime(0.0001, start + duration);
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start(start);
    osc.stop(start + duration + 0.02);
  },

  click() {
    this.tone(520, 0.055, 'sine', 0.025);
  },

  open() {
    this.tone(440, 0.07, 'sine', 0.03);
    this.tone(660, 0.09, 'sine', 0.035, 0.065);
  },

  join() {
    this.tone(392, 0.08, 'triangle', 0.035);
    this.tone(523, 0.08, 'triangle', 0.04, 0.07);
    this.tone(659, 0.12, 'triangle', 0.04, 0.14);
  },

  start() {
    this.tone(330, 0.08, 'square', 0.025);
    this.tone(440, 0.08, 'square', 0.028, 0.08);
    this.tone(660, 0.16, 'triangle', 0.045, 0.16);
  },

  question() {
    this.tone(620, 0.06, 'sine', 0.022);
    this.tone(760, 0.08, 'sine', 0.025, 0.055);
  },

  correct() {
    this.tone(523.25, 0.10, 'triangle', 0.045);
    this.tone(659.25, 0.10, 'triangle', 0.05, 0.085);
    this.tone(783.99, 0.18, 'triangle', 0.055, 0.17);
  },

  wrong() {
    this.tone(240, 0.12, 'sawtooth', 0.025);
    this.tone(185, 0.20, 'sawtooth', 0.028, 0.10);
  },

  timeout() {
    this.tone(300, 0.11, 'square', 0.025);
    this.tone(250, 0.15, 'square', 0.025, 0.12);
  },

  countdown() {
    this.tone(880, 0.055, 'sine', 0.02);
  },

  finish() {
    [523.25, 659.25, 783.99, 1046.5].forEach((f, i) => this.tone(f, 0.16, 'triangle', 0.045, i * 0.11));
    this.tone(783.99, 0.28, 'triangle', 0.04, 0.46);
  },

  badge() {
    this.tone(659.25, 0.08, 'triangle', 0.035);
    this.tone(880, 0.10, 'triangle', 0.04, 0.07);
    this.tone(1174.66, 0.16, 'triangle', 0.045, 0.15);
  },

  toggle() {
    this.enabled = !this.enabled;
    localStorage.setItem('mathArenaSound', this.enabled ? 'on' : 'off');
    updateSoundButton();
    if (this.enabled) {
      this.ensure();
      this.open();
    }
  }
};

function updateSoundButton() {
  const btn = $('soundToggleBtn');
  if (!btn) return;
  btn.textContent = sound.enabled ? '🔊' : '🔇';
  btn.setAttribute('aria-label', sound.enabled ? tr('soundDisable') : tr('soundEnable'));
  btn.title = sound.enabled ? tr('soundOn') : tr('soundOff');
  btn.classList.toggle('muted', !sound.enabled);
}

// Browserele permit audio doar după o interacțiune a utilizatorului.
['pointerdown', 'keydown'].forEach(eventName => {
  window.addEventListener(eventName, () => sound.ensure(), { once: true });
});



// ------------------------------------------------------------
// Efecte vizuale pentru copii: confetti, stele către scor și shake.
// Nu folosesc biblioteci externe și respectă prefers-reduced-motion.
// ------------------------------------------------------------
function motionAllowed() {
  return !window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
}

function ensureFxLayer() {
  let layer = document.getElementById('fxLayer');
  if (layer) return layer;
  layer = document.createElement('div');
  layer.id = 'fxLayer';
  layer.className = 'fx-layer';
  layer.setAttribute('aria-hidden', 'true');
  document.body.appendChild(layer);
  return layer;
}

function launchConfetti(originElement) {
  if (!motionAllowed()) return;
  const layer = ensureFxLayer();
  const rect = originElement?.getBoundingClientRect?.() || {
    left: window.innerWidth / 2,
    top: window.innerHeight / 2,
    width: 0,
    height: 0
  };
  const originX = rect.left + rect.width / 2;
  const originY = rect.top + Math.min(rect.height / 2, 90);
  const pieces = ['🎉', '✨', '●', '■', '▲'];

  for (let i = 0; i < 28; i++) {
    const el = document.createElement('span');
    el.className = 'confetti-piece';
    el.textContent = pieces[i % pieces.length];
    el.style.left = `${originX}px`;
    el.style.top = `${originY}px`;
    el.style.setProperty('--dx', `${(Math.random() - .5) * 420}px`);
    el.style.setProperty('--dy', `${-90 - Math.random() * 250}px`);
    el.style.setProperty('--fall', `${120 + Math.random() * 230}px`);
    el.style.setProperty('--rot', `${Math.round((Math.random() - .5) * 900)}deg`);
    el.style.setProperty('--delay', `${Math.random() * .12}s`);
    el.style.setProperty('--size', `${10 + Math.random() * 13}px`);
    layer.appendChild(el);
    el.addEventListener('animationend', () => el.remove(), { once: true });
  }
}

function flyStarsToScore(originElement, count = 6) {
  if (!motionAllowed()) return;
  const score = document.querySelector('.score-pill');
  if (!score || !originElement) return;
  const layer = ensureFxLayer();
  const from = originElement.getBoundingClientRect();
  const to = score.getBoundingClientRect();
  const startX = from.left + from.width / 2;
  const startY = from.top + from.height / 2;
  const endX = to.left + to.width / 2;
  const endY = to.top + to.height / 2;

  for (let i = 0; i < count; i++) {
    const star = document.createElement('span');
    star.className = 'flying-star';
    star.textContent = '⭐';
    star.style.left = `${startX + (Math.random() - .5) * 45}px`;
    star.style.top = `${startY + (Math.random() - .5) * 25}px`;
    star.style.setProperty('--tx', `${endX - startX}px`);
    star.style.setProperty('--ty', `${endY - startY}px`);
    star.style.setProperty('--delay', `${i * .055}s`);
    layer.appendChild(star);
    star.addEventListener('animationend', () => {
      star.remove();
      if (i === count - 1) {
        score.classList.remove('score-pop');
        void score.offsetWidth;
        score.classList.add('score-pop');
      }
    }, { once: true });
  }
}

function shakeWrongAnswer(button) {
  if (!motionAllowed()) return;
  const card = button.closest('.question-card');
  [button, card].filter(Boolean).forEach(el => {
    el.classList.remove('wrong-shake');
    void el.offsetWidth;
    el.classList.add('wrong-shake');
    el.addEventListener('animationend', () => el.classList.remove('wrong-shake'), { once: true });
  });
}

const state = {
  roomCode: null,
  room: null,
  rooms: [],
  grade: 1,
  mode: 'math',
  avatar: localStorage.getItem('mathArenaAvatar') || '🦊',
  streak: 0,
  badges: [],
  timerInterval: null,
  currentQuestionTime: 15,
  myScore: 0,
  answered: false,
  lastLeaderboard: [],
  licenseTier: 'free',
  licenseToken: '',
  activationId: (crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`),
  licenseKey: localStorage.getItem('mathArenaProLicense') || '',
  heartbeatTimer: null,
  licenseConfig: null,
  paypalRendered: false,
  language: localStorage.getItem('mathArenaLanguage') === 'en' ? 'en' : 'ro',
  currentAnswerLabels: new Map()
};


// ------------------------------------------------------------
// Limbi: română / engleză.
// Limba aleasă de gazdă devine limba camerei pentru toți jucătorii.
// ------------------------------------------------------------
const I18N = {
  ro: {
    soundOn: 'Sunete pornite',
    soundOff: 'Sunete oprite',
    soundEnable: 'Pornește sunetele',
    soundDisable: 'Oprește sunetele',

    heroEyebrow: 'Joacă • Învață • Zâmbește',
    heroTitle: 'Arena Matematica',
    heroLead: 'Alege rapid dacă vrei să pornești un joc sau să intri într-un joc deja creat.',

    createChoiceTitle: 'Pornește un joc',
    createChoiceText: 'Tu alegi clasa, tipul de întrebări și pornești joaca',
    joinChoiceTitle: 'Intră în joc',
    joinChoiceText: 'Scrii codul jocului sau alegi din lista de camere',
    back: 'Înapoi',

    createEyebrow: 'Creează joc',
    createHeading: 'Pregătește jocul',
    createHelper: 'Completează doar câteva lucruri și jocul este gata.',
    name: 'Cum te cheamă?',
    avatar: 'Alege-ți avatarul',
    grade: 'În ce clasă sunteți?',
    mode: 'Ce fel de întrebări?',
    math: 'Matematică',
    general: 'Cultură generală',
    mixed: 'Mixt',
    moreOptions: 'Mai multe opțiuni',
    questions: 'Întrebări',
    time: 'Timp',
    noTimer: 'Fără cronometru',
    createGame: 'Pornește jocul 🚀',

    joinEyebrow: 'Intră în joc',
    joinHeading: 'Hai în joc!',
    joinHelper: 'Spune-ne numele tău și intră imediat în camera potrivită.',
    join: 'Intră',
    orChoose: 'sau alege un joc',
    available: '🎯 Jocuri disponibile',

    adult: 'Pentru profesor / părinte',

    licenseEyebrow: 'Licența ta',
    licenseFreeText: 'deblochează primele 20 de întrebări.',
    licenseProText: 'deblochează peste 100 de întrebări.',
    licenseKeyLabel: '🔑 Ai deja o licență PRO?',
    proLicenseText: 'licență PRO',
    paypalUnavailable: 'Plata PayPal nu este configurată momentan.',
    purchasedLicenseLabel: '🎉 Licența ta PRO:',
    licenseKeepText:
      'Păstrează acest cod. Îl poți folosi și pe alt dispozitiv, dar nu simultan în două sesiuni.',
    teacherPanel: '👩‍🏫 Panou profesor',

    activePro: '⭐ PRO ACTIV',
    proActiveButton: 'PRO activ',
    activate: 'Activează',
    copyCode: 'Copiază codul',
    copied: 'Copiat ✓',
    selectCode: 'Selectează codul',

    enterLicense: 'Introdu codul licenței PRO.',
    licenseActivationFailed: 'Licența nu a putut fi activată.',
    licenseActivated: 'Licența PRO este activă pe această sesiune.',
    licenseServerError: 'Nu am putut contacta serverul pentru activarea licenței.',
    licenseExpired: 'Activarea PRO a expirat. Activează din nou codul.',

    paypalCreateFailed: 'Nu am putut crea comanda PayPal.',
    paypalConfirming: 'Confirmăm plata PayPal…',
    paypalConfirmFailed: 'Plata nu a putut fi confirmată.',
    paypalCancelled: 'Plata a fost anulată.',
    paypalError: 'A apărut o eroare PayPal. Încearcă din nou.',

    lobby: 'Camera de joc',
    gameOf: 'Jocul lui',
    leave: 'Ieși',
    gameCode: 'Codul jocului',
    shareCode: 'Spune codul colegilor tăi',
    whoPlays: '👧👦 Cine joacă?',
    ready: '✨ Gata de joacă?',
    start: 'Începem! 🚀',
    wait: '⏳ Gazda va porni jocul...',

    chooseCorrect: 'Alege răspunsul corect',
    boardShow: '🏆 Vezi clasamentul',
    boardHide: '🙈 Ascunde clasamentul',
    leaderboard: '🏆 Clasament',

    finished: 'Ai terminat!',
    badges: '🏅 Badge-urile tale',
    playAgain: 'Mai joc o dată 🎮',

    placeholderName: 'Prenumele tău',
    placeholderCode: 'Cod: 4821',

    emptyRooms: 'Nu este niciun joc disponibil acum.<br>Poți crea tu primul joc!',
    roomGame: 'Jocul lui',
    classWord: 'Clasa',
    noTime: 'Fără timp',
    you: 'tu',
    hostFallback: 'gazdei',

    allPro:
      '⭐ Toți jucătorii sunt PRO — banca completă de întrebări este activă.',

    freeRoom: n =>
      `🆓 Partida folosește banca FREE (primele ${n} de întrebări), deoarece există cel puțin un jucător FREE.`,

    secondsQuestion: 'secunde / întrebare',

    needName: 'Scrie mai întâi prenumele tău 🙂',
    joinFailed: 'Nu am putut intra în joc.',
    createFailed: 'Nu am putut crea jocul.',
    badCode: 'Codul jocului are 4 cifre 🙂',
    startFailed: 'Nu am putut porni jocul.',

    correct: (points, streak) =>
      `🌟 Bravo! +${points} stele!${streak >= 2 ? ` 🔥 Combo x${streak}!` : ''}`,

    wrong: answer =>
      `💪 Aproape! Răspunsul era ${answer}. Seria pornește din nou.`,

    timeout: answer =>
      `⏰ Timpul s-a terminat. Răspunsul era ${answer}.`,

    winner: 'Super! Ai câștigat! 🎉',
    bravo: 'Bravo! 🎉',

    final: (correct, total, score, best) =>
      `Ai rezolvat corect ${correct} din ${total} întrebări și ai strâns ${score} stele. Cea mai bună serie: ${best}.`,

    newBadge: 'Badge nou',
    noBadges: 'Mai joacă o rundă pentru a debloca badge-uri! 🌟',
    imageAlt: 'Imagine pentru întrebare'
  },

  en: {
    soundOn: 'Sounds on',
    soundOff: 'Sounds off',
    soundEnable: 'Turn sounds on',
    soundDisable: 'Turn sounds off',

    heroEyebrow: 'Play • Learn • Smile',
    heroTitle: 'Math Arena',
    heroLead:
      'Quickly choose whether you want to start a game or join one that has already been created.',

    createChoiceTitle: 'Start a game',
    createChoiceText: 'Choose the grade, question type and start playing',
    joinChoiceTitle: 'Join a game',
    joinChoiceText: 'Enter the game code or choose from the available rooms',
    back: 'Back',

    createEyebrow: 'Create game',
    createHeading: 'Set up the game',
    createHelper: 'Fill in just a few things and the game is ready.',
    name: 'What is your name?',
    avatar: 'Choose your avatar',
    grade: 'What grade are you in?',
    mode: 'What kind of questions?',
    math: 'Math',
    general: 'General knowledge',
    mixed: 'Mixed',
    moreOptions: 'More options',
    questions: 'Questions',
    time: 'Time',
    noTimer: 'No timer',
    createGame: 'Start game 🚀',

    joinEyebrow: 'Join game',
    joinHeading: 'Let’s play!',
    joinHelper: 'Tell us your name and join the right room right away.',
    join: 'Join',
    orChoose: 'or choose a game',
    available: '🎯 Available games',

    adult: 'For teacher / parent',

    licenseEyebrow: 'Your license',
    licenseFreeText: 'unlocks the first 20 questions.',
    licenseProText: 'unlocks more than 100 questions.',
    licenseKeyLabel: '🔑 Already have a PRO license?',
    proLicenseText: 'PRO license',
    paypalUnavailable: 'PayPal payment is currently unavailable.',
    purchasedLicenseLabel: '🎉 Your PRO license:',
    licenseKeepText:
      'Keep this code safe. You can use it on another device, but not simultaneously in two sessions.',
    teacherPanel: '👩‍🏫 Teacher panel',

    activePro: '⭐ PRO ACTIVE',
    proActiveButton: 'PRO active',
    activate: 'Activate',
    copyCode: 'Copy code',
    copied: 'Copied ✓',
    selectCode: 'Select code',

    enterLicense: 'Enter your PRO license code.',
    licenseActivationFailed: 'The license could not be activated.',
    licenseActivated: 'The PRO license is active for this session.',
    licenseServerError: 'Could not contact the server to activate the license.',
    licenseExpired: 'The PRO activation has expired. Activate the code again.',

    paypalCreateFailed: 'Could not create the PayPal order.',
    paypalConfirming: 'Confirming PayPal payment…',
    paypalConfirmFailed: 'The payment could not be confirmed.',
    paypalCancelled: 'The payment was cancelled.',
    paypalError: 'A PayPal error occurred. Please try again.',

    lobby: 'Game room',
    gameOf: 'Game hosted by',
    leave: 'Leave',
    gameCode: 'Game code',
    shareCode: 'Share this code with your classmates',
    whoPlays: '👧👦 Who is playing?',
    ready: '✨ Ready to play?',
    start: 'Start! 🚀',
    wait: '⏳ The host will start the game...',

    chooseCorrect: 'Choose the correct answer',
    boardShow: '🏆 View leaderboard',
    boardHide: '🙈 Hide leaderboard',
    leaderboard: '🏆 Leaderboard',

    finished: 'You finished!',
    badges: '🏅 Your badges',
    playAgain: 'Play again 🎮',

    placeholderName: 'Your first name',
    placeholderCode: 'Code: 4821',

    emptyRooms:
      'There are no available games right now.<br>You can create the first one!',
    roomGame: 'Game hosted by',
    classWord: 'Grade',
    noTime: 'No timer',
    you: 'you',
    hostFallback: 'host',

    allPro:
      '⭐ All players are PRO — the full question bank is active.',

    freeRoom: n =>
      `🆓 This game uses the FREE bank (the first ${n} questions) because at least one player is FREE.`,

    secondsQuestion: 'seconds / question',

    needName: 'Enter your first name first 🙂',
    joinFailed: 'Could not join the game.',
    createFailed: 'Could not create the game.',
    badCode: 'The game code has 4 digits 🙂',
    startFailed: 'Could not start the game.',

    correct: (points, streak) =>
      `🌟 Great! +${points} stars!${streak >= 2 ? ` 🔥 Combo x${streak}!` : ''}`,

    wrong: answer =>
      `💪 Almost! The correct answer was ${answer}. Your streak starts again.`,

    timeout: answer =>
      `⏰ Time is up. The correct answer was ${answer}.`,

    winner: 'Awesome! You won! 🎉',
    bravo: 'Great job! 🎉',

    final: (correct, total, score, best) =>
      `You answered ${correct} out of ${total} questions correctly and earned ${score} stars. Best streak: ${best}.`,

    newBadge: 'New badge',
    noBadges: 'Play another round to unlock badges! 🌟',
    imageAlt: 'Question image'
  }
};
function tr(key, ...args) {
  const value = I18N[state.language]?.[key] ?? I18N.ro[key] ?? key;
  return typeof value === 'function' ? value(...args) : value;
}
const fixedI18n = {
  heroEyebrow: 'heroEyebrow',
  heroTitle: 'heroTitle',
  heroLead: 'heroLead',

  createChoiceTitle: 'createChoiceTitle',
  createChoiceText: 'createChoiceText',
  joinChoiceTitle: 'joinChoiceTitle',
  joinChoiceText: 'joinChoiceText',

  createEyebrow: 'createEyebrow',
  createHeading: 'createHeading',
  createHelper: 'createHelper',
  createNameLabel: 'name',
  gradeLabelText: 'grade',
  modeLabelText: 'mode',
  moreOptionsLabel: 'moreOptions',
  questionsLabel: 'questions',
  timeLabel: 'time',
  noTimerLabel: 'noTimer',
  createSubmitBtn: 'createGame',

  joinEyebrow: 'joinEyebrow',
  joinHeading: 'joinHeading',
  joinHelper: 'joinHelper',
  joinNameLabel: 'name',
  joinByCodeBtn: 'join',
  orChooseGame: 'orChoose',
  availableGamesHeading: 'available',

  adultZoneLabel: 'adult',

  licenseEyebrow: 'licenseEyebrow',
  licenseFreeText: 'licenseFreeText',
  licenseProText: 'licenseProText',
  licenseKeyLabel: 'licenseKeyLabel',
  proLicenseText: 'proLicenseText',
  paypalUnavailable: 'paypalUnavailable',
  purchasedLicenseLabel: 'purchasedLicenseLabel',
  licenseKeepText: 'licenseKeepText',
  teacherPanelLink: 'teacherPanel',

  lobbyEyebrow: 'lobby',
  hostGamePrefix: 'gameOf',
  leaveBtn: 'leave',
  gameCodeLabel: 'gameCode',
  shareCodeLabel: 'shareCode',
  whoPlaysHeading: 'whoPlays',
  readyHeading: 'ready',
  startBtn: 'start',
  waitText: 'wait',

  chooseAnswerLabel: 'chooseCorrect',
  leaderboardHeading: 'leaderboard',

  finishedEyebrow: 'finished',
  earnedBadgesTitle: 'badges',
  backHomeBtn: 'playAgain'
};
function setLanguage(language, { persist = true, rerender = true } = {}) {

  state.language = language === 'en' ? 'en' : 'ro';

  if (persist) {
    localStorage.setItem('mathArenaLanguage', state.language);
  }

  document.documentElement.lang = state.language;

  document.title =
    state.language === 'en'
      ? 'Math Arena'
      : 'Arena Matematică';

  if (state.language === 'en') {
    void getQuestionTranslator();
  }

  $('langRoBtn')?.classList.toggle(
    'selected',
    state.language === 'ro'
  );

  $('langEnBtn')?.classList.toggle(
    'selected',
    state.language === 'en'
  );

  for (const [id, key] of Object.entries(fixedI18n)) {
    const element = $(id);

    if (element) {
      element.textContent = tr(key);
    }
  }

  document.querySelectorAll('.back-label').forEach(el => {
    el.textContent = tr('back');
  });

  document.querySelectorAll('.avatar-label').forEach(el => {
    el.textContent = tr('avatar');
  });

  document.querySelectorAll('.math-mode-label').forEach(el => {
    el.textContent = tr('math');
  });

  document.querySelectorAll('.general-mode-label').forEach(el => {
    el.textContent = tr('general');
  });

  document.querySelectorAll('.mixed-mode-label').forEach(el => {
    el.textContent = tr('mixed');
  });

  if ($('createName')) {
    $('createName').placeholder = tr('placeholderName');
  }

  if ($('joinName')) {
    $('joinName').placeholder = tr('placeholderName');
  }

  if ($('roomCodeInput')) {
    $('roomCodeInput').placeholder = tr('placeholderCode');
  }

  // Butonul pentru copierea licenței
  if ($('copyLicenseBtn')) {
    $('copyLicenseBtn').textContent = tr('copyCode');
  }

  updateSoundButton();
  updateLicenseUi();

  if (rerender) {
    renderRooms();

    if (state.room) {
      renderLobby(state.room);
    }
  }
}

const QUESTION_FALLBACK = {
  // Traduceri locale pentru întrebările FREE de cultură generală (funcționează și fără Browser Translator API).
  'Câte zile are o săptămână?':'How many days are in a week?','Câte luni are un an?':'How many months are in a year?','În ce anotimp ninge de obicei?':'In which season does it usually snow?','Ce animal spune „miau”?':'Which animal says “meow”?','Cu ce organ vedem?':'Which organ do we use to see?','Cu ce organ auzim?':'Which organ do we use to hear?','Ce culoare obții din albastru și galben?':'What color do you get by mixing blue and yellow?','Ce animal trăiește de obicei în apă?':'Which animal usually lives in water?','Câte laturi are un pătrat?':'How many sides does a square have?','Care formă nu are colțuri?':'Which shape has no corners?','Câte ore are o zi?':'How many hours are in a day?','Câte minute are o oră?':'How many minutes are in an hour?','Câți bani sunt într-un leu?':'How many bani are in one Romanian leu?','Ce ne oferă Soarele în timpul zilei?':'What does the Sun give us during the day?','Care animal are aripi?':'Which animal has wings?','Care este o vocală?':'Which one is a vowel?','În ce țară se află București?':'Which country is Bucharest in?','Apa este de obicei...':'Water is usually...','De ce are nevoie o plantă ca să crească?':'What does a plant need in order to grow?','Ce culoare a semaforului înseamnă „oprește”?':'Which traffic-light color means “stop”?',
  'Primăvara':'Spring','Vara':'Summer','Toamna':'Autumn','Iarna':'Winter','Pisica':'Cat','Câinele':'Dog','Vaca':'Cow','Rața':'Duck','Ochii':'Eyes','Urechile':'Ears','Nasul':'Nose','Mâinile':'Hands','Picioarele':'Feet','Dinții':'Teeth','Verde':'Green','Roșu':'Red','Mov':'Purple','Portocaliu':'Orange','Peștele':'Fish','Calul':'Horse','Găina':'Hen','Cercul':'Circle','Pătratul':'Square','Triunghiul':'Triangle','Dreptunghiul':'Rectangle','100 bani':'100 bani','10 bani':'10 bani','50 bani':'50 bani','1000 bani':'1000 bani','Lumină':'Light','Zăpadă':'Snow','Pământ':'Earth','Ploaie':'Rain','Pasărea':'Bird','România':'Romania','Franța':'France','Italia':'Italy','Spania':'Spain','solidă':'solid','lichidă':'liquid','metal':'metal','gaz permanent':'permanent gas','Apă și lumină':'Water and light','Doar întuneric':'Only darkness','Doar pietre':'Only stones','Galben':'Yellow','Albastru':'Blue',
  'Simboluri pentru anotimpuri':'Season symbols','Pește stilizat':'Stylized fish','Forme geometrice':'Geometric shapes','Ceas analogic':'Analog clock','Monede stilizate':'Stylized coins','Pasăre stilizată':'Stylized bird','Harta României':'Map of Romania','Plantă cu rădăcină, tulpină, frunze și floare':'Plant with roots, stem, leaves and flower','Semafor cu trei culori':'Three-color traffic light',
  'Adunare':'Addition','Scădere':'Subtraction','Înmulțire':'Multiplication','Împărțire':'Division','Număr lipsă':'Missing number',
  'Matematică':'Math','Geografie':'Geography','Natură':'Nature','Animale':'Animals','Corp':'Body','Culori':'Colors','Forme':'Shapes','Timp':'Time','Calendar':'Calendar','Bani':'Money','Limbă':'Language','Știință':'Science','Siguranță':'Safety','Numărare':'Counting','Geometrie':'Geometry','Logică':'Logic','Vreme':'Weather','Biologie':'Biology','Astronomie':'Astronomy','Muzică':'Music','Artă':'Art','Mediu':'Environment','Sănătate':'Health','Viață de zi cu zi':'Everyday life','Cultură generală':'General knowledge'
};
let questionTranslatorPromise = null;
async function getQuestionTranslator() {
  if (state.language !== 'en') return null;
  if (questionTranslatorPromise) return questionTranslatorPromise;
  questionTranslatorPromise = (async () => {
    try {
      if (window.Translator?.create) return await window.Translator.create({ sourceLanguage: 'ro', targetLanguage: 'en' });
      if (window.translation?.createTranslator) return await window.translation.createTranslator({ sourceLanguage: 'ro', targetLanguage: 'en' });
    } catch (error) { console.warn('Browser translation unavailable:', error); }
    return null;
  })();
  return questionTranslatorPromise;
}
async function translateQuestionValue(value, translator) {
  const text = String(value ?? '');
  if (!text || state.language !== 'en') return text;
  if (QUESTION_FALLBACK[text]) return QUESTION_FALLBACK[text];
  if (/^[\d\s+×÷−=?.:/-]+$/.test(text)) return text;
  if (!translator) return text;
  try { return await translator.translate(text); } catch { return text; }
}
async function localizedQuestion(question) {
  state.currentAnswerLabels = new Map();
  if (state.language !== 'en') {
    question.answers.forEach(a => state.currentAnswerLabels.set(String(a), String(a)));
    return question;
  }

  // Întrebările builtin vin deja cu traducerea EN statică de la server.
  if (question.translation?.text && Array.isArray(question.translation.answers)) {
    const answers = question.translation.answers;
    question.answers.forEach((a, i) => state.currentAnswerLabels.set(String(a), answers[i] || String(a)));
    return {
      ...question,
      kind: question.translation.kind || question.kind,
      text: question.translation.text || question.text,
      imageAlt: question.translation.imageAlt || question.imageAlt || '',
      displayAnswers: answers
    };
  }

  // Fallback doar pentru întrebările personalizate adăugate ulterior.
  const translator = await getQuestionTranslator();
  const [kind, text, imageAlt, ...answers] = await Promise.all([
    translateQuestionValue(question.kind, translator), translateQuestionValue(question.text, translator), translateQuestionValue(question.imageAlt || '', translator),
    ...question.answers.map(a => translateQuestionValue(a, translator))
  ]);
  question.answers.forEach((a, i) => state.currentAnswerLabels.set(String(a), answers[i] || String(a)));
  return { ...question, kind, text, imageAlt, displayAnswers: answers };
}
function answerLabel(value) { return state.currentAnswerLabels.get(String(value)) || String(value); }


function showScreen(id) {
  screens.forEach(screen => $(screen).classList.toggle('hidden', screen !== id));
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

function showHomeChoice() {
  $('homeChoice').classList.remove('hidden');
  $('createPanel').classList.add('hidden');
  $('joinPanel').classList.add('hidden');
  $('homeError').textContent = '';
}

function showAction(panel) {
  $('homeChoice').classList.add('hidden');
  $('createPanel').classList.toggle('hidden', panel !== 'create');
  $('joinPanel').classList.toggle('hidden', panel !== 'join');
  $('homeError').textContent = '';
  if (panel === 'join') socket.emit('rooms:request');
}

function error(message) { $('homeError').textContent = message || ''; }
function gradeLabel(grade) { return ['I', 'II', 'III', 'IV'][Number(grade) - 1] || grade; }
function modeLabel(mode) {
  return { math: `🧮 ${tr('math')}`, general: `🌍 ${tr('general')}`, mixed: `🎲 ${tr('mixed')}` }[mode] || `🧮 ${tr('math')}`;
}
function rememberName(name) {
  localStorage.setItem('mathArenaName', name);
  $('createName').value = name;
  $('joinName').value = name;
}
function currentJoinName() { return $('joinName').value.trim(); }
function escapeHtml(value) {
  return String(value).replace(/[&<>'"]/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#039;', '"': '&quot;' }[ch]));
}

const BADGE_INFO = {
  ro: {
    first: { icon: '🌟', name: 'Primul succes', description: 'Primul răspuns corect' },
    streak3: { icon: '🔥', name: 'Pe val!', description: '3 răspunsuri corecte la rând' },
    streak5: { icon: '⚡', name: 'Imbatabil!', description: '5 răspunsuri corecte la rând' },
    fast: { icon: '🚀', name: 'Fulger', description: 'Răspuns corect foarte rapid' },
    expert10: { icon: '🏆', name: 'Expert', description: '10 răspunsuri corecte într-un joc' }
  },
  en: {
    first: { icon: '🌟', name: 'First success', description: 'Your first correct answer' },
    streak3: { icon: '🔥', name: 'On fire!', description: '3 correct answers in a row' },
    streak5: { icon: '⚡', name: 'Unstoppable!', description: '5 correct answers in a row' },
    fast: { icon: '🚀', name: 'Lightning', description: 'A very fast correct answer' },
    expert10: { icon: '🏆', name: 'Expert', description: '10 correct answers in one game' }
  }
};
function badgeInfo(id) { return BADGE_INFO[state.language]?.[id] || BADGE_INFO.ro[id] || { icon: '🏅', name: id, description: '' }; }
function selectAvatar(avatar) {
  state.avatar = avatar || '🦊';
  localStorage.setItem('mathArenaAvatar', state.avatar);
  document.querySelectorAll('.avatar-btn').forEach(btn => btn.classList.toggle('selected', btn.dataset.avatar === state.avatar));
}
function renderCombo(streak = 0) {
  state.streak = Number(streak) || 0;
  if (!$('comboPill')) return;
  $('comboCount').textContent = state.streak;
  $('comboPill').classList.toggle('hidden', state.streak < 2);
  if (state.streak >= 2) { $('comboPill').classList.remove('combo-pop'); void $('comboPill').offsetWidth; $('comboPill').classList.add('combo-pop'); }
}
function showBadgeToast(badgeId) {
  const info = badgeInfo(badgeId), toast = $('badgeToast');
  if (!toast) return;
  toast.innerHTML = `<span class="badge-toast-icon">${info.icon}</span><span><strong>${tr('newBadge')}: ${escapeHtml(info.name)}</strong><small>${escapeHtml(info.description)}</small></span>`;
  toast.classList.remove('hidden', 'badge-toast-in'); void toast.offsetWidth; toast.classList.add('badge-toast-in');
  sound.badge();
  setTimeout(() => toast.classList.add('hidden'), 2600);
}
function renderBadgeShelf(ids = []) {
  const el = $('finalBadges'); if (!el) return;
  const unique = [...new Set(ids || [])];
  el.innerHTML = unique.length ? unique.map(id => { const b = badgeInfo(id); return `<div class="earned-badge"><span>${b.icon}</span><strong>${escapeHtml(b.name)}</strong><small>${escapeHtml(b.description)}</small></div>`; }).join('') : `<div class="no-badges">${tr('noBadges')}</div>`;
}

function updateLicenseUi(message = '', isError = false) {

  const isPro = state.licenseTier === 'pro';

  $('licenseStatus').textContent =
    isPro ? tr('activePro') : 'FREE';

  $('licenseStatus').className =
    `license-status ${isPro ? 'pro' : 'free'}`;

  $('licenseKeyInput').value =
    state.licenseKey || '';

  $('activateLicenseBtn').textContent =
    isPro
      ? tr('proActiveButton')
      : tr('activate');

  $('activateLicenseBtn').disabled = isPro;

  $('licenseMessage').textContent = message;

  $('licenseMessage').className =
    `license-message ${
      message
        ? (isError ? 'bad' : 'ok')
        : ''
    }`;
}

function setLicenseFree(message = '') {
  state.licenseTier = 'free';
  state.licenseToken = '';
  clearInterval(state.heartbeatTimer);
  state.heartbeatTimer = null;
  updateLicenseUi(message, Boolean(message));
  socket.emit('license:refresh', { licenseToken: '' });
}

async function activateLicense(key, { silent = false } = {}) {

  const licenseKey =
    String(key || '')
      .trim()
      .toUpperCase();

  if (!licenseKey) {

    if (!silent) {
      updateLicenseUi(
        tr('enterLicense'),
        true
      );
    }

    return false;
  }

  try {

    const response = await fetch('/api/license/activate', {
      method: 'POST',

      headers: {
        'Content-Type': 'application/json'
      },

      body: JSON.stringify({
        licenseKey,
        activationId: state.activationId
      })
    });

    const data = await response.json();

    if (!response.ok || !data.ok) {

      setLicenseFree('');

      if (!silent) {
        updateLicenseUi(
          data.message || tr('licenseActivationFailed'),
          true
        );
      }

      return false;
    }

    state.licenseTier = 'pro';
    state.licenseToken = data.token;
    state.licenseKey = licenseKey;

    localStorage.setItem(
      'mathArenaProLicense',
      licenseKey
    );

    updateLicenseUi(
      tr('licenseActivated')
    );

    startLicenseHeartbeat(
      Number(data.heartbeatMs) || 15000
    );

    socket.emit('license:refresh', {
      licenseToken: state.licenseToken
    });

    return true;

  } catch {

    if (!silent) {
      updateLicenseUi(
        tr('licenseServerError'),
        true
      );
    }

    return false;
  }
}

function startLicenseHeartbeat(intervalMs) {
  clearInterval(state.heartbeatTimer);
  if (!state.licenseToken) return;
  state.heartbeatTimer = setInterval(async () => {
    try {
      const response = await fetch('/api/license/heartbeat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: state.licenseToken })
      });
      if (!response.ok) setLicenseFree('Activarea PRO a expirat. Activează din nou codul.');
    } catch {
      // O eroare scurtă de rețea nu dezactivează imediat UI-ul; serverul decide lease-ul real.
    }
  }, Math.max(5000, intervalMs));
}

async function restoreLicense() {
  if (!state.licenseKey) return updateLicenseUi();
  await activateLicense(state.licenseKey, { silent: true });
}

async function loadLicenseConfig() {
  try {
    const response = await fetch('/api/license/config');
    const data = await response.json();
    state.licenseConfig = data;
    if (data.paypal?.price && data.paypal?.currency) {
      $('proPrice').textContent = `${data.paypal.price} ${data.paypal.currency}`;
    }
    if (!data.paypal?.enabled || !data.paypal?.clientId) {
      $('paypalUnavailable').classList.remove('hidden');
      return;
    }
    await loadPayPalSdk(data.paypal.clientId, data.paypal.currency);
    renderPayPalButtons();
  } catch {
    $('paypalUnavailable').classList.remove('hidden');
  }
}

function loadPayPalSdk(clientId, currency) {
  return new Promise((resolve, reject) => {
    if (window.paypal) return resolve();
    const script = document.createElement('script');
    script.src = `https://www.paypal.com/sdk/js?client-id=${encodeURIComponent(clientId)}&currency=${encodeURIComponent(currency)}&intent=capture&components=buttons`;
    script.async = true;
    script.onload = resolve;
    script.onerror = reject;
    document.head.appendChild(script);
  });
}

function renderPayPalButtons() {

  if (!window.paypal || state.paypalRendered) {
    return;
  }

  state.paypalRendered = true;

  window.paypal.Buttons({

    style: {
      layout: 'vertical',
      shape: 'rect',
      label: 'paypal'
    },

    createOrder: async () => {

      const response =
        await fetch('/api/paypal/orders', {
          method: 'POST'
        });

      const data = await response.json();

      if (!response.ok || !data.orderId) {
        throw new Error(
          data.message ||
          tr('paypalCreateFailed')
        );
      }

      return data.orderId;
    },

    onApprove: async data => {

      $('licenseMessage').textContent =
        tr('paypalConfirming');

      const response = await fetch(
        `/api/paypal/orders/${encodeURIComponent(data.orderID)}/capture`,
        {
          method: 'POST'
        }
      );

      const result =
        await response.json();

      if (
        !response.ok ||
        !result.licenseKey
      ) {

        updateLicenseUi(
          result.message ||
          tr('paypalConfirmFailed'),
          true
        );

        return;
      }

      state.licenseKey =
        result.licenseKey;

      localStorage.setItem(
        'mathArenaProLicense',
        result.licenseKey
      );

      $('purchasedLicenseKey').textContent =
        result.licenseKey;

      $('licenseResult')
        .classList
        .remove('hidden');

      await activateLicense(
        result.licenseKey
      );
    },

    onCancel: () => {
      updateLicenseUi(
        tr('paypalCancelled'),
        true
      );
    },

    onError: () => {
      updateLicenseUi(
        tr('paypalError'),
        true
      );
    }

  }).render('#paypal-button-container');
}
function joinRoom(code) {
  const name = currentJoinName();
  if (!name) {
    error(tr('needName'));
    $('joinName').focus();
    return;
  }
  error('');
  rememberName(name);
  socket.emit('room:join', { name, code: String(code), avatar: state.avatar, licenseToken: state.licenseToken }, response => {
    if (!response?.ok) return error(response?.message || tr('joinFailed'));
    state.roomCode = response.code;
    sound.join();
    showScreen('lobbyScreen');
  });
}

function renderRooms() {
  const rooms = state.rooms || [];
  $('roomsCount').textContent = rooms.length;
  if (!rooms.length) {
    $('availableRooms').innerHTML = `<div class="empty-rooms"><span class="emoji">🕹️</span>${tr('emptyRooms')}</div>`;
    return;
  }
  $('availableRooms').innerHTML = rooms.map(room => `
    <div class="room-item">
      <div>
        <div class="room-title">🎮 ${tr('roomGame')} ${escapeHtml(room.hostName)} <span class="room-language">${room.language === 'en' ? '🇬🇧 EN' : '🇷🇴 RO'}</span></div>
        <div class="room-meta">
          <span>📚 ${tr('classWord')} ${gradeLabel(room.grade)}</span><span>${modeLabel(room.mode)}</span>
          <span>👧👦 ${room.players}/${room.maxPlayers}</span><span>❓ ${room.questions}</span>
          <span>${room.noTimer ? `🌈 ${tr('noTime')}` : `⏱️ ${room.questionTime}s`}</span>
          <span>${room.contentTier === 'pro' ? '⭐ PRO' : '🆓 FREE'}</span>
        </div>
      </div>
      <button class="join-room-btn" data-room="${room.code}" type="button">${tr('join')} 🚀</button>
    </div>`).join('');
  document.querySelectorAll('[data-room]').forEach(btn => btn.addEventListener('click', () => joinRoom(btn.dataset.room)));
}

function renderLobby(room) {
  state.room = room;
  state.roomCode = room.code;
  const host = room.players.find(player => player.id === room.hostId);
  $('hostName').textContent = host?.name || tr('hostFallback');
  $('roomCode').textContent = room.code;
  $('playersList').innerHTML = room.players.map(player => `
    <div class="player-row ${player.id === socket.id ? 'me' : ''}">
      <span class="player-name"><span class="player-avatar">${escapeHtml(player.avatar || '🦊')}</span>${escapeHtml(player.name)}${player.id === room.hostId ? ' 👑' : ''}</span>
      <span class="player-tier ${player.tier}">${player.tier === 'pro' ? '⭐ PRO' : 'FREE'}</span>
      <span>${player.id === socket.id ? tr('you') : ''}</span>
    </div>`).join('');
  const tierText = room.contentTier === 'pro'
    ? tr('allPro')
    : tr('freeRoom', room.freeQuestionLimit || 20);
  $('settingsBox').innerHTML = `
    <div class="setting-chip">📚 ${tr('classWord')} ${gradeLabel(room.settings.grade)}</div>
    <div class="setting-chip">${modeLabel(room.settings.mode)}</div>
    <div class="setting-chip">❓ ${room.settings.questions} ${tr('questions').toLowerCase()}</div>
    <div class="setting-chip">${room.settings.noTimer ? `🌈 ${tr('noTimer')}` : `⏱️ ${room.settings.questionTime} ${tr('secondsQuestion')}`}</div>
    <div class="room-tier-note ${room.contentTier}">${tierText}</div>`;
  const amHost = room.hostId === socket.id;
  $('startBtn').classList.toggle('hidden', !amHost || room.status !== 'lobby');
  $('waitText').classList.toggle('hidden', amHost || room.status !== 'lobby');
  if (room.status === 'lobby') showScreen('lobbyScreen');
}

function renderLeaderboard(players, target = 'leaderboard') {
  const medals = ['🥇', '🥈', '🥉'];
  $(target).innerHTML = players.map((player, index) => `
    <div class="rank-row ${player.id === socket.id ? 'me' : ''}">
      <span><span class="medal">${medals[index] || `${index + 1}.`}</span> <span class="player-avatar">${escapeHtml(player.avatar || '🦊')}</span> ${escapeHtml(player.name)} ${player.tier === 'pro' ? '⭐' : ''} ${player.streak >= 2 ? `<span class="mini-streak">🔥${player.streak}</span>` : ''}</span>
      <strong>⭐ ${player.score}</strong>
    </div>`).join('');
}

function startVisualTimer(seconds, noTimer) {
  clearInterval(state.timerInterval);
  $('timerWrap').classList.toggle('hidden', noTimer);
  if (noTimer) return;
  const started = Date.now(), total = seconds * 1000;
  $('timerBar').style.width = '100%';
  state.timerInterval = setInterval(() => {
    const left = Math.max(0, total - (Date.now() - started));
    $('timerBar').style.width = `${(left / total) * 100}%`;
    const secondsLeft = Math.ceil(left / 1000);
    if (secondsLeft > 0 && secondsLeft <= 3 && sound.lastCountdownSecond !== secondsLeft) {
      sound.lastCountdownSecond = secondsLeft;
      sound.countdown();
    }
    if (left <= 0) clearInterval(state.timerInterval);
  }, 80);
}
function disableAnswers() { document.querySelectorAll('.answer-btn').forEach(btn => btn.disabled = true); }
function markCorrectAnswer(correct) { document.querySelectorAll('.answer-btn').forEach(btn => { if (btn.dataset.answer === String(correct)) btn.classList.add('correct-answer'); }); }
function answerQuestion(button) {
  if (state.answered) return;
  state.answered = true;
  disableAnswers();
  socket.emit('game:answer', { answer: button.dataset.answer }, response => {
    if (!response?.ok) return;
    state.myScore = response.score;
    $('myScore').textContent = state.myScore;
    renderCombo(response.streak);
    state.badges = response.badges || state.badges;
    if (response.isCorrect) {
      sound.correct();
      button.classList.add('correct-answer');
      launchConfetti(button);
      flyStarsToScore(button, 7);
      $('answerFeedback').className = 'feedback ok';
      const comboText = response.streak >= 2 ? ` 🔥 Combo x${response.streak}!` : '';
      $('answerFeedback').textContent = tr('correct', response.points, response.streak);
    } else {
      sound.wrong();
      button.classList.add('wrong-answer');
      shakeWrongAnswer(button);
      markCorrectAnswer(response.correctAnswer);
      $('answerFeedback').className = 'feedback bad';
      $('answerFeedback').textContent = tr('wrong', answerLabel(response.correctAnswer));
    }
    (response.newBadges || []).forEach((badgeId, index) => setTimeout(() => showBadgeToast(badgeId), index * 450));
  });
}
async function renderQuestion(question) {
  question = await localizedQuestion(question);
  state.answered = false;
  sound.lastCountdownSecond = null;
  sound.question();
  $('questionProgress').textContent = `${question.index} / ${question.total}`;
  $('questionKind').textContent = question.kind;
  $('gameTier').textContent = question.contentTier === 'pro' ? '⭐ PRO · 100+' : 'FREE · 20';
  $('gameTier').className = `tier-pill ${question.contentTier}`;
  $('questionText').textContent = question.text;
  $('answerFeedback').className = 'feedback';
  $('answerFeedback').textContent = '';
  $('answers').innerHTML = question.answers.map((answer, index) => `<button class="answer-btn" data-answer="${escapeHtml(answer)}" type="button">${escapeHtml(question.displayAnswers?.[index] || answer)}</button>`).join('');
  const hasImage = Boolean(question.image);
  $('questionImageWrap').classList.toggle('hidden', !hasImage);
  if (hasImage) { $('questionImage').src = question.image; $('questionImage').alt = question.imageAlt || tr('imageAlt'); }
  else { $('questionImage').removeAttribute('src'); $('questionImage').alt = ''; }
  document.querySelectorAll('.answer-btn').forEach(btn => btn.addEventListener('click', () => answerQuestion(btn)));
  startVisualTimer(question.questionTime, question.noTimer);
  showScreen('gameScreen');
}
function resetToHome() {
  clearInterval(state.timerInterval);
  state.roomCode = null; state.room = null; state.myScore = 0; state.answered = false; state.streak = 0; state.badges = []; renderCombo(0);
  $('myScore').textContent = '0'; $('liveBoardCard').classList.add('hidden'); $('toggleBoardBtn').textContent = tr('boardShow');
  showHomeChoice(); showScreen('homeScreen'); socket.emit('rooms:request');
}

$('langRoBtn').addEventListener('click', () => { if (!state.roomCode) setLanguage('ro'); });
$('langEnBtn').addEventListener('click', () => { if (!state.roomCode) setLanguage('en'); });

$('soundToggleBtn').addEventListener('click', event => {
  event.stopPropagation();
  sound.toggle();
});
updateSoundButton();

// Feedback sonor discret pentru butoanele obișnuite.
document.addEventListener('click', event => {
  const button = event.target.closest('button');
  if (!button || button.id === 'soundToggleBtn' || button.classList.contains('answer-btn')) return;
  sound.click();
});

$('showCreateBtn').addEventListener('click', () => { sound.open(); showAction('create'); });
$('showJoinBtn').addEventListener('click', () => { sound.open(); showAction('join'); });
document.querySelectorAll('[data-back-home]').forEach(btn => btn.addEventListener('click', showHomeChoice));
document.querySelectorAll('.grade-btn').forEach(btn => btn.addEventListener('click', () => {
  state.grade = Number(btn.dataset.grade);
  document.querySelectorAll('.grade-btn').forEach(b => b.classList.toggle('selected', b === btn));
}));
document.querySelectorAll('.mode-btn').forEach(btn => btn.addEventListener('click', () => {
  state.mode = btn.dataset.mode;
  document.querySelectorAll('.mode-btn').forEach(b => b.classList.toggle('selected', b === btn));
}));
document.querySelectorAll('.avatar-btn').forEach(btn => btn.addEventListener('click', () => selectAvatar(btn.dataset.avatar)));

$('activateLicenseBtn').addEventListener('click', () => activateLicense($('licenseKeyInput').value));
$('licenseKeyInput').addEventListener('keydown', event => { if (event.key === 'Enter') { event.preventDefault(); $('activateLicenseBtn').click(); } });
$('copyLicenseBtn').addEventListener('click', async () => {
  try { await navigator.clipboard.writeText($('purchasedLicenseKey').textContent); $('copyLicenseBtn').textContent = tr('copied'); }
  catch { $('copyLicenseBtn').textContent = tr('selectCode'); }
});

$('createForm').addEventListener('submit', event => {
  event.preventDefault();
  const name = $('createName').value.trim();
  if (!name) return error(tr('needName'));
  rememberName(name); error('');
  socket.emit('room:create', {
    name, avatar: state.avatar, grade: state.grade, mode: state.mode, language: state.language,
    questions: Number($('questions').value), questionTime: Number($('questionTime').value), noTimer: $('noTimer').checked,
    licenseToken: state.licenseToken
  }, response => {
    if (!response?.ok) return error(response?.message || tr('createFailed'));
    state.roomCode = response.code; sound.join(); showScreen('lobbyScreen');
  });
});
$('joinByCodeBtn').addEventListener('click', () => {
  const code = $('roomCodeInput').value.trim();
  if (!/^\d{4}$/.test(code)) return error(tr('badCode'));
  joinRoom(code);
});
$('roomCodeInput').addEventListener('keydown', event => { if (event.key === 'Enter') $('joinByCodeBtn').click(); });
$('startBtn').addEventListener('click', () => {
  $('startBtn').disabled = true;
  socket.emit('room:start', response => {
    if (!response?.ok) { $('startBtn').disabled = false; alert(response?.message || tr('startFailed')); }
  });
});
$('leaveBtn').addEventListener('click', () => { socket.emit('room:leave'); resetToHome(); });
$('backHomeBtn').addEventListener('click', () => { socket.emit('room:leave'); resetToHome(); });
$('toggleBoardBtn').addEventListener('click', () => {
  const card = $('liveBoardCard'); card.classList.toggle('hidden');
  $('toggleBoardBtn').textContent = card.classList.contains('hidden') ? tr('boardShow') : tr('boardHide');
});

socket.on('connect', () => {
  if (state.licenseToken) socket.emit('license:refresh', { licenseToken: state.licenseToken });
});
socket.on('rooms:list', rooms => { state.rooms = rooms; renderRooms(); });
socket.on('room:state', room => { if (room?.settings?.language) setLanguage(room.settings.language, { persist: false, rerender: false }); renderLobby(room); });
socket.on('game:started', () => { sound.start(); state.myScore = 0; state.streak = 0; state.badges = []; renderCombo(0); $('myScore').textContent = '0'; $('startBtn').disabled = false; });
socket.on('game:question', question => renderQuestion(question));
socket.on('game:leaderboard', players => { state.lastLeaderboard = players; renderLeaderboard(players); });
socket.on('game:questionEnd', data => {
  clearInterval(state.timerInterval); disableAnswers(); markCorrectAnswer(data.correctAnswer); renderLeaderboard(data.leaderboard);
  if (!state.answered) { sound.timeout(); $('answerFeedback').className = 'feedback bad'; $('answerFeedback').textContent = tr('timeout', answerLabel(data.correctAnswer)); }
});
socket.on('game:finished', data => {
  clearInterval(state.timerInterval); sound.finish(); renderLeaderboard(data.leaderboard, 'finalLeaderboard');
  const me = data.leaderboard.find(player => player.id === socket.id);
  const place = data.leaderboard.findIndex(player => player.id === socket.id) + 1;
  $('finalTitle').textContent = place === 1 ? tr('winner') : tr('bravo');
  $('finalMessage').textContent = tr('final', me?.correct || 0, data.totalQuestions, me?.score || 0, me?.bestStreak || 0);
  state.badges = me?.badges || state.badges; renderBadgeShelf(state.badges);
  showScreen('finalScreen');
});

window.addEventListener('pagehide', () => {
  if (!state.licenseToken) return;
  const blob = new Blob([JSON.stringify({ token: state.licenseToken })], { type: 'application/json' });
  navigator.sendBeacon('/api/license/deactivate', blob);
});

const savedName = localStorage.getItem('mathArenaName') || '';
if (savedName) rememberName(savedName);
setLanguage(state.language, { persist: false, rerender: false });
updateLicenseUi();
renderRooms();
loadLicenseConfig();
restoreLicense();
