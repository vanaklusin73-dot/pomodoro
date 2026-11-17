/* ============================================================
   Таймер Помодоро — логика
   ============================================================ */

(function () {
  "use strict";

  /* ---------- Конфигурация режимов ---------- */

  const MODES = {
    work: {
      duration: 25 * 60,
      label: "Время работать",
      doneLabel: "Работа завершена",
      nextMode: "break",
      nextText: "Время отдохнуть — 5 минут перерыва",
      title: "Работа",
    },
    break: {
      duration: 5 * 60,
      label: "Время отдохнуть",
      doneLabel: "Перерыв закончен",
      nextMode: "work",
      nextText: "Возвращаемся к работе — 25 минут фокуса",
      title: "Перерыв",
    },
  };

  const STORAGE_KEY = "pomodoro:sound";
  const RING_RADIUS = 134;
  const RING_LENGTH = 2 * Math.PI * RING_RADIUS;

  /* ---------- Ссылки на элементы ---------- */

  const body = document.body;
  const timerEl = document.querySelector(".timer");
  const displayEl = document.getElementById("timerDisplay");
  const labelEl = document.getElementById("timerLabel");
  const sessionEl = document.getElementById("sessionInfo");
  const progressEl = document.getElementById("progressBar");
  const startBtn = document.getElementById("startBtn");
  const resetBtn = document.getElementById("resetBtn");
  const skipBtn = document.getElementById("skipBtn");
  const soundBtn = document.getElementById("soundToggle");
  const modeButtons = Array.from(document.querySelectorAll(".mode"));
  const toastEl = document.getElementById("toast");

  /* ---------- Состояние ---------- */

  const state = {
    mode: "work",
    /** Оставшееся время в миллисекундах */
    remaining: MODES.work.duration * 1000,
    /** Метка времени окончания, пока таймер запущен */
    endAt: null,
    running: false,
    completed: 0,
    soundOn: true,
    frameId: null,
    lastShownSecond: null,
  };

  /* ---------- Звук (Web Audio API, без внешних файлов) ---------- */

  let audioCtx = null;

  function getAudioContext() {
    if (audioCtx) return audioCtx;
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return null;
    audioCtx = new Ctx();
    return audioCtx;
  }

  /** Один чистый «колокольчик»: основной тон + мягкая октава */
  function playTone(ctx, startAt, frequency, duration, gainLevel) {
    const partials = [
      { ratio: 1, level: gainLevel, type: "sine" },
      { ratio: 2, level: gainLevel * 0.28, type: "triangle" },
    ];

    partials.forEach(function (partial) {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();

      osc.type = partial.type;
      osc.frequency.setValueAtTime(frequency * partial.ratio, startAt);

      gain.gain.setValueAtTime(0.0001, startAt);
      gain.gain.exponentialRampToValueAtTime(partial.level, startAt + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, startAt + duration);

      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(startAt);
      osc.stop(startAt + duration + 0.05);
    });
  }

  /** Трёхнотный сигнал по окончании таймера */
  function playChime() {
    if (!state.soundOn) return;

    const ctx = getAudioContext();
    if (!ctx) return;

    if (ctx.state === "suspended") {
      ctx.resume().catch(function () {});
    }

    const now = ctx.currentTime + 0.02;
    const notes = [
      { freq: 880.0, delay: 0.0, duration: 0.55, level: 0.32 },
      { freq: 1174.66, delay: 0.18, duration: 0.55, level: 0.28 },
      { freq: 1567.98, delay: 0.36, duration: 0.9, level: 0.26 },
    ];

    notes.forEach(function (note) {
      playTone(ctx, now + note.delay, note.freq, note.duration, note.level);
    });

    if (typeof navigator.vibrate === "function") {
      navigator.vibrate([120, 60, 120]);
    }
  }

  /* ---------- Форматирование ---------- */

  function formatTime(ms) {
    const totalSeconds = Math.max(0, Math.ceil(ms / 1000));
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    return {
      text: String(minutes).padStart(2, "0") + ":" + String(seconds).padStart(2, "0"),
      totalSeconds: totalSeconds,
      minutes: minutes,
      seconds: seconds,
    };
  }

  function formatDuration(seconds) {
    return "PT" + Math.floor(seconds / 60) + "M" + (seconds % 60) + "S";
  }

  /* ---------- Отрисовка ---------- */

  function renderProgress() {
    const total = MODES[state.mode].duration * 1000;
    const ratio = Math.min(1, Math.max(0, state.remaining / total));
    progressEl.style.strokeDasharray = String(RING_LENGTH);
    progressEl.style.strokeDashoffset = String(RING_LENGTH * (1 - ratio));
  }

  function isFresh() {
    return state.remaining === MODES[state.mode].duration * 1000;
  }

  function render() {
    const time = formatTime(state.remaining);

    displayEl.textContent = time.text;
    displayEl.setAttribute("datetime", formatDuration(time.totalSeconds));
    displayEl.setAttribute("aria-live", state.running ? "off" : "polite");

    renderProgress();

    timerEl.classList.toggle("is-running", state.running);
    startBtn.classList.toggle("is-running", state.running);
    startBtn.textContent = state.running ? "Пауза" : isFresh() ? "Старт" : "Продолжить";

    document.title = state.running
      ? time.text + " · " + MODES[state.mode].title + " — Помодоро"
      : "Помодоро — таймер фокуса";

    sessionEl.textContent = "Помидоров завершено: " + state.completed;
  }

  function renderMode() {
    body.dataset.mode = state.mode;
    labelEl.textContent = MODES[state.mode].label;

    modeButtons.forEach(function (button) {
      const active = button.dataset.mode === state.mode;
      button.classList.toggle("is-active", active);
      button.setAttribute("aria-selected", String(active));
      button.tabIndex = active ? 0 : -1;
    });
  }

  /* ---------- Таймер ---------- */

  function stopLoop() {
    state.running = false;
    state.endAt = null;
    if (state.frameId !== null) {
      window.cancelAnimationFrame(state.frameId);
      state.frameId = null;
    }
  }

  function tick() {
    if (!state.running) return;

    state.remaining = Math.max(0, state.endAt - Date.now());
    const time = formatTime(state.remaining);

    if (time.totalSeconds !== state.lastShownSecond) {
      state.lastShownSecond = time.totalSeconds;
      displayEl.textContent = time.text;
      displayEl.setAttribute("datetime", formatDuration(time.totalSeconds));
      document.title = time.text + " · " + MODES[state.mode].title + " — Помодоро";
      renderProgress();
    }

    if (state.remaining <= 0) {
      finish();
      return;
    }

    state.frameId = window.requestAnimationFrame(tick);
  }

  function start() {
    if (state.running) return;

    if (state.remaining <= 0) {
      state.remaining = MODES[state.mode].duration * 1000;
    }

    // Разблокируем звук внутри пользовательского жеста
    const ctx = getAudioContext();
    if (ctx && ctx.state === "suspended") {
      ctx.resume().catch(function () {});
    }

    state.running = true;
    state.endAt = Date.now() + state.remaining;
    state.lastShownSecond = null;
    timerEl.classList.remove("is-done");
    render();
    state.frameId = window.requestAnimationFrame(tick);
  }

  function pause() {
    if (!state.running) return;

    state.remaining = Math.max(0, state.endAt - Date.now());
    stopLoop();
    render();
  }

  function toggle() {
    if (state.running) {
      pause();
    } else {
      start();
    }
  }

  function reset() {
    stopLoop();
    state.remaining = MODES[state.mode].duration * 1000;
    timerEl.classList.remove("is-done");
    render();
    showToast("Таймер сброшен: " + MODES[state.mode].title.toLowerCase());
  }

  function setMode(mode, options) {
    if (!MODES[mode]) return;

    const opts = options || {};
    const sameMode = mode === state.mode;

    stopLoop();
    state.mode = mode;
    state.remaining = MODES[mode].duration * 1000;
    timerEl.classList.remove("is-done");

    renderMode();
    render();

    if (!sameMode && !opts.silent) {
      showToast("Режим: " + MODES[mode].title + " · " + Math.round(MODES[mode].duration / 60) + " мин");
    }

    if (opts.autoStart) {
      start();
    }
  }

  /** Завершение отсчёта: сигнал, счётчик, переход в следующий режим */
  function finish() {
    const finishedMode = state.mode;
    const config = MODES[finishedMode];

    stopLoop();
    state.remaining = 0;
    render();

    timerEl.classList.add("is-done");
    playChime();

    if (finishedMode === "work") {
      state.completed += 1;
      sessionEl.textContent = "Помидоров завершено: " + state.completed;
    }

    showToast(config.doneLabel + " · " + config.nextText, 5200);

    window.setTimeout(function () {
      timerEl.classList.remove("is-done");
      setMode(config.nextMode, { silent: true });
    }, 1400);
  }

  /* ---------- Уведомление ---------- */

  let toastTimer = null;

  function showToast(message, duration) {
    if (!toastEl) return;

    toastEl.textContent = message;
    toastEl.classList.add("is-visible");

    if (toastTimer !== null) {
      window.clearTimeout(toastTimer);
    }

    toastTimer = window.setTimeout(function () {
      toastEl.classList.remove("is-visible");
      toastTimer = null;
    }, duration || 3000);
  }

  /* ---------- Звук: вкл / выкл ---------- */

  function applySoundState() {
    soundBtn.classList.toggle("is-off", !state.soundOn);
    soundBtn.setAttribute("aria-pressed", String(state.soundOn));
    soundBtn.setAttribute("aria-label", state.soundOn ? "Выключить звук" : "Включить звук");
    soundBtn.title = state.soundOn ? "Звук включён" : "Звук выключен";
  }

  function loadSoundState() {
    try {
      const stored = window.localStorage.getItem(STORAGE_KEY);
      if (stored === "off") state.soundOn = false;
      if (stored === "on") state.soundOn = true;
    } catch (error) {
      /* localStorage может быть недоступен — работаем по умолчанию */
    }
    applySoundState();
  }

  function toggleSound() {
    state.soundOn = !state.soundOn;

    try {
      window.localStorage.setItem(STORAGE_KEY, state.soundOn ? "on" : "off");
    } catch (error) {
      /* игнорируем ошибки хранилища */
    }

    applySoundState();
    showToast(state.soundOn ? "Звук включён" : "Звук выключен", 1800);

    if (state.soundOn) {
      const ctx = getAudioContext();
      if (ctx) {
        if (ctx.state === "suspended") ctx.resume().catch(function () {});
        const now = ctx.currentTime + 0.02;
        playTone(ctx, now, 880, 0.35, 0.22);
        playTone(ctx, now + 0.12, 1318.51, 0.45, 0.2);
      }
    }
  }

  /* ---------- События ---------- */

  startBtn.addEventListener("click", toggle);
  resetBtn.addEventListener("click", reset);

  skipBtn.addEventListener("click", function () {
    setMode(MODES[state.mode].nextMode);
  });

  soundBtn.addEventListener("click", toggleSound);

  modeButtons.forEach(function (button) {
    button.addEventListener("click", function () {
      setMode(button.dataset.mode);
    });
  });

  // Стрелки для навигации по табам режимов
  modeButtons.forEach(function (button, index) {
    button.addEventListener("keydown", function (event) {
      if (event.key !== "ArrowRight" && event.key !== "ArrowLeft") return;
      event.preventDefault();
      const offset = event.key === "ArrowRight" ? 1 : -1;
      const next = modeButtons[(index + offset + modeButtons.length) % modeButtons.length];
      next.focus();
      setMode(next.dataset.mode);
    });
  });

  document.addEventListener("keydown", function (event) {
    const target = event.target;
    const isTyping =
      target instanceof HTMLElement &&
      (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable);

    if (isTyping || event.ctrlKey || event.metaKey || event.altKey) return;

    if (event.code === "Space" || event.key === " ") {
      event.preventDefault();
      toggle();
      return;
    }

    // R / К — сброс, 1 / 2 — режимы, S / Ы — звук (учтена русская раскладка)
    if (event.key === "r" || event.key === "R" || event.key === "к" || event.key === "К") {
      event.preventDefault();
      reset();
      return;
    }

    if (event.key === "1") {
      event.preventDefault();
      setMode("work");
      return;
    }

    if (event.key === "2") {
      event.preventDefault();
      setMode("break");
      return;
    }

    if (event.key === "s" || event.key === "S" || event.key === "ы" || event.key === "Ы") {
      event.preventDefault();
      toggleSound();
    }
  });

  // Возврат на вкладку: пересчитываем оставшееся время
  document.addEventListener("visibilitychange", function () {
    if (document.visibilityState !== "visible" || !state.running) return;

    state.remaining = Math.max(0, state.endAt - Date.now());

    if (state.remaining <= 0) {
      finish();
    } else {
      render();
    }
  });

  /* ---------- Инициализация ---------- */

  loadSoundState();
  renderMode();
  render();

})();
