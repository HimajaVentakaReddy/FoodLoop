"use strict";

const STORAGE_KEYS = {
  foods: "foodloop-foods-v1",
  history: "foodloop-history-v1",
  activity: "foodloop-activity-v1"
};
const HISTORY_LIMIT = 5;
const ACTIVITY_LIMIT = 12;
const HIGH_PRIORITY_MS = 30 * 60 * 1000;
const MEDIUM_PRIORITY_MS = 2 * 60 * 60 * 1000;
// Transparent prototype assumptions; these are estimates, not measured outcomes.
const ESTIMATES = { wasteKgPerMeal: 0.45, co2KgPerMeal: 0.25 };

const LEGACY_SAMPLE_NAMES = [
  "Vegetable Rice",
  "Sandwiches",
  "Dal & Rice",
  "Fresh Salad"
];

function hasLegacySampleFood(food) {
  if (!food || typeof food !== "object") return false;
  const id = String(food.id || "");
  const name = String(food.name || "");
  return id.startsWith("sample-") || LEGACY_SAMPLE_NAMES.includes(name);
}

function clearSavedData() {
  Object.values(STORAGE_KEYS).forEach((key) => {
    try {
      localStorage.removeItem(key);
    } catch (error) {
      console.error("FoodLoop could not clear saved browser data.", error);
    }
  });

  foods = [];
  history = [];
  activity = [];
  currentFilter = "all";
  searchInput.value = "";
  renderApp();
  showToast("Saved board data cleared. The campus board is empty and ready for new food rescues.");
}

const $ = (id) => document.getElementById(id);
const foodGrid = $("foodGrid");
const foodForm = $("foodForm");
const searchInput = $("searchInput");
const undoButton = $("undoButton");
const undoCount = $("undoCount");
const toastRegion = $("toastRegion");
const claimDialog = $("claimDialog");
const claimForm = $("claimForm");
const claimFormView = $("claimFormView");
const claimSuccessView = $("claimSuccessView");

let foods = loadFoods();
let history = loadHistory();
let activity = loadActivity();
let currentFilter = "all";
let selectedFoodId = null;
let tickerIndex = 0;
let tickerMessages = [];

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function loadFoods() {
  try {
    const stored = localStorage.getItem(STORAGE_KEYS.foods);
    if (stored === null) return [];

    const parsed = JSON.parse(stored);
    if (!Array.isArray(parsed)) throw new Error("Saved food data is not a list.");

    if (parsed.some((food) => hasLegacySampleFood(food))) {
      Object.values(STORAGE_KEYS).forEach((key) => localStorage.removeItem(key));
      return [];
    }

    return parsed.filter((food) =>
      food &&
      typeof food.id === "string" &&
      typeof food.name === "string" &&
      typeof food.location === "string" &&
      Number.isFinite(Number(food.servings)) &&
      Number(food.servings) > 0
    ).map((food) => normalizeFood(food));
  } catch (error) {
    console.error("FoodLoop could not load saved food data.", error);
    return [];
  }
}

function normalizeFood(food) {
  let expiresAt = Number(food.expiresAt);
  if (!Number.isFinite(expiresAt)) {
    const time = typeof food.availableUntil === "string" ? food.availableUntil : "";
    const match = time.match(/^(\d{1,2}):(\d{2})$/);
    const now = new Date();
    if (match) {
      now.setHours(Number(match[1]), Number(match[2]), 0, 0);
      if (now.getTime() <= Date.now()) now.setDate(now.getDate() + 1);
      expiresAt = now.getTime();
    } else {
      expiresAt = Date.now() + 60 * 60 * 1000;
    }
  }

  return {
    ...food,
    servings: Number(food.servings),
    expiresAt,
    category: food.category || "Meal",
    foodType: food.foodType || "Vegetarian",
    claimed: Boolean(food.claimed),
    volunteerName: typeof food.volunteerName === "string" ? food.volunteerName : "",
    arrivalTime: typeof food.arrivalTime === "string" ? food.arrivalTime : "",
    contact: typeof food.contact === "string" ? food.contact : "",
    claimedAt: Number(food.claimedAt) || null
  };
}

function loadHistory() {
  try {
    const stored = localStorage.getItem(STORAGE_KEYS.history);
    if (stored === null) return [];
    const parsed = JSON.parse(stored);
    if (!Array.isArray(parsed)) throw new Error("Saved action history is not a list.");
    return parsed.filter((entry) =>
      entry && entry.state && Array.isArray(entry.state.foods) && Array.isArray(entry.state.activity)
    ).slice(-HISTORY_LIMIT);
  } catch (error) {
    console.error("FoodLoop could not load saved undo history.", error);
    return [];
  }
}

function loadActivity() {
  try {
    const stored = localStorage.getItem(STORAGE_KEYS.activity);
    if (stored === null) return [];
    const parsed = JSON.parse(stored);
    if (!Array.isArray(parsed)) throw new Error("Saved activity is not a list.");
    return parsed.filter((item) =>
      item &&
      typeof item.message === "string" &&
      Number.isFinite(Number(item.createdAt))
    ).slice(0, ACTIVITY_LIMIT);
  } catch (error) {
    console.error("FoodLoop could not load recent activity.", error);
    return [];
  }
}

function persistState(nextFoods, nextHistory, nextActivity) {
  const values = {
    [STORAGE_KEYS.foods]: JSON.stringify(nextFoods),
    [STORAGE_KEYS.history]: JSON.stringify(nextHistory),
    [STORAGE_KEYS.activity]: JSON.stringify(nextActivity)
  };
  const oldValues = {};

  // Roll back successful writes if a later LocalStorage write fails.
  try {
    Object.keys(values).forEach((key) => { oldValues[key] = localStorage.getItem(key); });
    Object.entries(values).forEach(([key, value]) => localStorage.setItem(key, value));
    return true;
  } catch (error) {
    Object.entries(oldValues).forEach(([key, value]) => {
      try {
        if (value === null) localStorage.removeItem(key);
        else localStorage.setItem(key, value);
      } catch (restoreError) {
        console.error("FoodLoop could not restore browser storage after a failed save.", restoreError);
      }
    });
    console.error("FoodLoop could not save application state.", error);
    showToast("Your change could not be saved. Check browser storage and try again.", "error");
    return false;
  }
}

function snapshotState() {
  // Undo restores both the board and its recent activity feed.
  return clone({ foods, activity });
}

function addActivity(message, kind = "post") {
  return [{ id: `${Date.now()}-${Math.random()}`, message, kind, createdAt: Date.now() }, ...activity]
    .slice(0, ACTIVITY_LIMIT);
}

function performAction(label, message, kind, update) {
  const before = snapshotState();
  const nextHistory = [...history, { label, state: before }].slice(-HISTORY_LIMIT);
  const updated = update(clone(foods));
  const nextActivity = [{ id: `${Date.now()}-${Math.random()}`, message, kind, createdAt: Date.now() }, ...activity]
    .slice(0, ACTIVITY_LIMIT);

  if (!persistState(updated, nextHistory, nextActivity)) return false;
  foods = updated;
  history = nextHistory;
  activity = nextActivity;
  renderApp();
  return true;
}

function undoLastAction() {
  if (!history.length) {
    showToast("Nothing to undo yet.");
    return;
  }

  const entry = history[history.length - 1];
  const previousFoods = foods;
  const previousHistory = history;
  const previousActivity = activity;
  const restoredActivity = entry.state.activity;
  const nextActivity = [{
    id: `${Date.now()}-${Math.random()}`,
    message: `Undid: ${entry.label}`,
    kind: "undo",
    createdAt: Date.now()
  }, ...restoredActivity].slice(0, ACTIVITY_LIMIT);
  const nextHistory = history.slice(0, -1);

  if (!persistState(entry.state.foods, nextHistory, nextActivity)) {
    foods = previousFoods;
    history = previousHistory;
    activity = previousActivity;
    return;
  }

  foods = clone(entry.state.foods);
  history = nextHistory;
  activity = nextActivity;
  renderApp();
  showToast(`↩ Undid: ${entry.label}`);
}

function priorityFor(food, now = Date.now()) {
  const remaining = Number(food.expiresAt) - now;
  if (remaining <= 0) return { level: "EXPIRED", key: "expired", score: 0, remaining };
  if (remaining <= HIGH_PRIORITY_MS) {
    return { level: "HIGH PRIORITY", key: "high", score: Math.max(90, Math.round(100 - remaining / HIGH_PRIORITY_MS * 10)), remaining };
  }
  if (remaining <= MEDIUM_PRIORITY_MS) {
    const score = Math.round(60 + (MEDIUM_PRIORITY_MS - remaining) / (MEDIUM_PRIORITY_MS - HIGH_PRIORITY_MS) * 29);
    return { level: "MEDIUM PRIORITY", key: "medium", score, remaining };
  }
  const score = Math.max(1, Math.round(59 - Math.min(1, (remaining - MEDIUM_PRIORITY_MS) / (24 * 60 * 60 * 1000)) * 49));
  return { level: "LOW PRIORITY", key: "low", score, remaining };
}

function isExpired(food, now = Date.now()) {
  return !food.claimed && Number(food.expiresAt) <= now;
}

function isAvailable(food, now = Date.now()) {
  return !food.claimed && Number(food.expiresAt) > now;
}

function formatCountdown(milliseconds) {
  const totalSeconds = Math.max(0, Math.floor(milliseconds / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

function formatClock(timestamp) {
  return new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" }).format(new Date(timestamp));
}

function formatDateTime(timestamp) {
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(new Date(timestamp));
}

function formatRelative(timestamp) {
  const elapsedSeconds = Math.max(0, Math.floor((Date.now() - timestamp) / 1000));
  if (elapsedSeconds < 60) return "just now";
  if (elapsedSeconds < 3600) return `${Math.floor(elapsedSeconds / 60)} min ago`;
  if (elapsedSeconds < 86400) return `${Math.floor(elapsedSeconds / 3600)} hr ago`;
  return `${Math.floor(elapsedSeconds / 86400)} days ago`;
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  })[character]);
}

function foodEmoji(name) {
  const value = name.toLowerCase();
  if (value.includes("sandwich")) return "🥪";
  if (value.includes("rice") || value.includes("biryani") || value.includes("dal")) return "🍛";
  if (value.includes("fruit") || value.includes("apple")) return "🍎";
  if (value.includes("salad") || value.includes("vegetable")) return "🥗";
  if (value.includes("bread") || value.includes("toast")) return "🍞";
  if (value.includes("pizza")) return "🍕";
  if (value.includes("soup")) return "🍲";
  return "🍱";
}

function prioritySort(a, b) {
  // Urgent listings sort first, expired food next, and reserved food last.
  if (a.claimed !== b.claimed) return a.claimed ? 1 : -1;
  if (!a.claimed) {
    const now = Date.now();
    const aExpired = Number(a.expiresAt) <= now;
    const bExpired = Number(b.expiresAt) <= now;
    if (aExpired !== bExpired) return aExpired ? 1 : -1;
    return Number(a.expiresAt) - Number(b.expiresAt);
  }
  return Number(b.claimedAt || 0) - Number(a.claimedAt || 0);
}

function renderBoard() {
  const now = Date.now();
  const query = searchInput.value.trim().toLowerCase();
  const sortedFoods = [...foods].sort(prioritySort);
  const visibleFoods = getVisibleFoods(sortedFoods, query, currentFilter, now);

  if (!visibleFoods.length) {
    const noFoods = foods.length === 0;
    foodGrid.innerHTML = `
      <div class="empty-state">
        <div class="empty-illustration"><span>🌱</span></div>
        <p class="empty-kicker">Campus network is ready</p>
        <h3>${noFoods ? "No active food rescues" : "No listings match this view"}</h3>
        <p>${noFoods ? "When campus kitchens post surplus food, it will appear here in real time." : "Great news for campus sustainability. When surplus food is available, it will appear here in real time."}</p>
        <p class="empty-subtext">Every rescue starts with one listing.</p>
        <div class="empty-actions">
          <a class="button button-primary button-large empty-button" href="#post-food">Post the First Rescue →</a>
          <button class="button button-light empty-clear" type="button">Reset demo data</button>
        </div>
      </div>
    `;
    return;
  }

  foodGrid.innerHTML = visibleFoods.map(renderFoodCard).join("");
}

function getVisibleFoods(items, query, filter, now = Date.now()) {
  return items.filter((food) => {
    const priority = priorityFor(food, now);
    const expired = isExpired(food, now);
    const statusMatch = filter === "all" ||
      (filter === "urgent" && !food.claimed && !expired && priority.key === "high") ||
      (filter === "available" && isAvailable(food, now)) ||
      (filter === "claimed" && food.claimed) ||
      (filter === "expired" && expired);
    return statusMatch && `${food.name} ${food.location} ${food.category}`.toLowerCase().includes(query);
  });
}

function renderFoodCard(food) {
  const priority = priorityFor(food);
  const expired = isExpired(food);
  const available = isAvailable(food);
  const stateClass = food.claimed ? "claimed-card" : expired ? "expired-card" : `priority-${priority.key}`;
  const statusText = food.claimed ? "RESERVED" : expired ? "EXPIRED" : "AVAILABLE";
  const statusClass = food.claimed ? "status-claimed" : expired ? "status-expired" : "status-available";
  const priorityLabel = food.claimed ? "RESCUE CONFIRMED" : priority.level;
  const countdownText = food.claimed ? `Reserved at ${formatClock(food.claimedAt || Date.now())}` :
    expired ? "EXPIRED — no longer available" : `⏳ ${formatCountdown(priority.remaining)} remaining`;
  const progress = food.claimed || expired ? 0 : Math.min(100, Math.max(2, priority.remaining / (4 * 60 * 60 * 1000) * 100));
  const claimLabel = food.claimed ? "🤝 RESERVED" : expired ? "⏰ Listing expired" : "🤝 Claim This Food";
  const helper = food.claimed
    ? `<div class="rescued-by">Rescued by <strong>${escapeHtml(food.volunteerName || "Campus volunteer")}</strong>${food.arrivalTime ? ` · arriving ${escapeHtml(food.arrivalTime.toLowerCase())}` : ""}</div>`
    : `<div class="priority-score"><span>🚨 RESCUE PRIORITY</span><strong>${priority.score}<small>/100</small></strong></div>`;
  const cardProgress = `<div class="freshness-track" aria-label="${progress.toFixed(0)} percent of the four-hour freshness window remains"><span style="--progress:${progress}%"></span></div>`;
  const disabled = !available ? "disabled" : "";

  return `<article class="food-card ${stateClass}" data-food-id="${escapeHtml(food.id)}" data-priority-level="${priority.key}">
    <div class="card-top"><div class="food-symbol">${foodEmoji(food.name)}</div><div class="card-badges"><span class="priority-badge badge-${food.claimed ? "claimed" : priority.key}">${food.claimed ? "💚" : priority.key === "high" ? "🔴" : priority.key === "medium" ? "🟠" : priority.key === "expired" ? "⚫" : "🟢"} ${priorityLabel}</span><span class="status-badge ${statusClass}">${statusText}</span></div></div>
    <div class="food-title-row"><div><h3>${escapeHtml(food.name)}</h3><span class="food-category">${escapeHtml(food.category)} · ${escapeHtml(food.foodType)}</span></div><span class="card-servings">👥 <strong>${food.servings}</strong></span></div>
    <div class="food-location"><span>📍</span>${escapeHtml(food.location)}</div>
    <div class="countdown-line ${priority.key === "high" ? "countdown-urgent" : priority.key === "medium" ? "countdown-soon" : ""}" data-countdown="${escapeHtml(food.id)}">${countdownText}</div>
    ${cardProgress}
    <p class="food-description">${escapeHtml(food.description || "Freshly prepared surplus food, ready to be shared.")}</p>
    ${helper}
    <button class="claim-button" type="button" data-claim-id="${escapeHtml(food.id)}" ${disabled}>${claimLabel}</button>
  </article>`;
}

function updateCountdowns() {
  const now = Date.now();
  let stateChanged = false;
  document.querySelectorAll(".food-card[data-food-id]").forEach((card) => {
    const food = foods.find((item) => item.id === card.dataset.foodId);
    if (!food || food.claimed) return;
    const priority = priorityFor(food, now);
    if (card.dataset.priorityLevel !== priority.key) {
      stateChanged = true;
      return;
    }
    const countdown = card.querySelector("[data-countdown]");
    if (countdown) {
      countdown.textContent = priority.key === "expired"
        ? "EXPIRED — no longer available"
        : `⏳ ${formatCountdown(priority.remaining)} remaining`;
      countdown.classList.toggle("countdown-urgent", priority.key === "high");
      countdown.classList.toggle("countdown-soon", priority.key === "medium");
    }
    const progress = card.querySelector(".freshness-track > span");
    if (progress) progress.style.setProperty("--progress", `${Math.min(100, Math.max(2, priority.remaining / (4 * 60 * 60 * 1000) * 100))}%`);
  });
  // Rebuild cards only when a priority threshold changes, not on every tick.
  if (stateChanged) renderBoard();
  return stateChanged;
}

function animateNumber(element, target, suffix = "") {
  const start = Number(element.dataset.value || 0);
  if (start === target) {
    element.textContent = `${target}${suffix}`;
    return;
  }
  if (window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
    element.textContent = `${target}${suffix}`;
    element.dataset.value = String(target);
    return;
  }

  const startTime = performance.now();
  const duration = 520;
  const step = (now) => {
    const progress = Math.min(1, (now - startTime) / duration);
    const eased = 1 - Math.pow(1 - progress, 3);
    const decimals = Number.isInteger(target) ? 0 : 1;
    element.textContent = `${(start + (target - start) * eased).toFixed(decimals).replace(/\.0$/, "")}${suffix}`;
    if (progress < 1) requestAnimationFrame(step);
    else element.dataset.value = String(target);
  };
  requestAnimationFrame(step);
}

function updateStatistics() {
  const now = Date.now();
  const available = foods.filter((food) => isAvailable(food, now));
  const claimed = foods.filter((food) => food.claimed);
  const mealsAvailable = available.reduce((sum, food) => sum + food.servings, 0);
  const mealsRescued = claimed.reduce((sum, food) => sum + food.servings, 0);
  const wasteKg = mealsRescued * ESTIMATES.wasteKgPerMeal;
  const co2Kg = mealsRescued * ESTIMATES.co2KgPerMeal;

  animateNumber($("mealsAvailable"), mealsAvailable);
  animateNumber($("claimsCount"), claimed.length);
  animateNumber($("activeListings"), available.length);
  animateNumber($("wastePrevented"), Math.round(wasteKg * 10) / 10, " kg");
  animateNumber($("impactMeals"), mealsRescued);
  animateNumber($("impactClaims"), claimed.length, " claims");
  animateNumber($("impactWaste"), Math.round(wasteKg * 10) / 10, " kg");
  animateNumber($("co2Estimate"), Math.round(co2Kg * 10) / 10, " kg");
  animateNumber($("impactActive"), mealsAvailable);
  $("allCount").textContent = foods.length;
  $("urgentCount").textContent = foods.filter((food) => isAvailable(food, now) && priorityFor(food, now).key === "high").length;
  $("availableCount").textContent = available.length;
  $("claimedCount").textContent = claimed.length;
  $("expiredCount").textContent = foods.filter((food) => isExpired(food, now)).length;
  $("impactProgress").style.width = `${Math.min(100, mealsRescued / 250 * 100)}%`;
  $("impactProgress").setAttribute("aria-valuenow", String(Math.min(100, Math.round(mealsRescued / 250 * 100))));
}

function renderActivity() {
  const list = $("activityList");
  if (!activity.length) {
    list.innerHTML = '<li class="activity-empty">🌱 Your campus rescue story starts here.</li>';
    return;
  }
  list.innerHTML = activity.slice(0, 5).map((item) => {
    const icon = item.kind === "claim" ? "🤝" : item.kind === "undo" ? "↩" : "🟢";
    return `<li class="activity-item"><span class="activity-icon">${icon}</span><span class="activity-message">${escapeHtml(item.message)}</span><time datetime="${new Date(item.createdAt).toISOString()}">${formatRelative(item.createdAt)}</time></li>`;
  }).join("");
}

function updateCampusMap() {
  document.querySelectorAll(".map-place[data-place]").forEach((place) => {
    const placeName = place.dataset.place.toLowerCase();
    const aliases = {
      "hostel block a": ["hostel block a", "main hostel mess"],
      "main canteen": ["main canteen"],
      "campus café": ["campus café", "campus cafe", "college cafeteria", "campus cafeteria"],
      "student activity center": ["student activity center", "student center"]
    };
    const placeAliases = aliases[placeName] || [placeName];
    const listings = foods.filter((food) => {
      const location = food.location.toLowerCase();
      return isAvailable(food) && placeAliases.some((alias) => location.includes(alias) || alias.includes(location));
    });
    place.classList.toggle("has-food", listings.length > 0);
    const status = place.querySelector(".place-status");
    if (status) status.textContent = listings.length ? `${listings.length} active listing${listings.length === 1 ? "" : "s"}` : "Ready to share";
  });
}

function updateUndoButton() {
  undoButton.disabled = history.length === 0;
  undoCount.textContent = `History: ${history.length}/${HISTORY_LIMIT}`;
}

function initializeLucideIcons() {
  if (window.lucide && typeof window.lucide.createIcons === "function") {
    window.lucide.createIcons({
      attrs: {
        class: "lucide-icon"
      }
    });
  }
}

function renderApp() {
  renderBoard();
  updateStatistics();
  renderActivity();
  updateCampusMap();
  updateUndoButton();
  updateTickerMessages();
  initializeLucideIcons();
}

function updateTickerMessages() {
  const available = foods.filter((food) => isAvailable(food)).sort(prioritySort);
  const recentClaim = activity.find((item) => item.kind === "claim");
  const meals = available.reduce((sum, food) => sum + food.servings, 0);
  tickerMessages = [
    available.length ? `🟢 ${available[0].name} is live at ${available[0].location}` : "🌱 New listings appear here as campus kitchens share surplus",
    recentClaim ? `🤝 ${recentClaim.message}` : `🤝 ${foods.filter((food) => food.claimed).length} food rescues completed on campus`,
    `🌍 ${meals} meals are waiting to be rescued`,
    "♻️ Priority sorting helps volunteers find food that needs help first"
  ];
  const ticker = $("tickerMessage");
  if (ticker && !ticker.textContent) ticker.textContent = tickerMessages[tickerIndex % tickerMessages.length];
}

function rotateTicker() {
  const ticker = $("tickerMessage");
  if (!tickerMessages.length) return;
  ticker.classList.add("ticker-out");
  window.setTimeout(() => {
    tickerIndex = (tickerIndex + 1) % tickerMessages.length;
    ticker.textContent = tickerMessages[tickerIndex];
    ticker.classList.remove("ticker-out");
    ticker.classList.add("ticker-in");
    window.setTimeout(() => ticker.classList.remove("ticker-in"), 380);
  }, 220);
}

function showToast(message, type = "success") {
  const toast = document.createElement("div");
  toast.className = `toast${type === "error" ? " error" : ""}`;
  toast.setAttribute("role", type === "error" ? "alert" : "status");
  const icon = type === "error" ? "⚠️" : message.startsWith("↩") ? "↩" : "✨";
  toast.innerHTML = `<span class="toast-icon">${icon}</span><span>${escapeHtml(message)}</span>`;
  toastRegion.appendChild(toast);
  window.setTimeout(() => toast.remove(), 3800);
}

function updateExpiryInput() {
  const minimum = new Date(Date.now() + 10 * 60 * 1000);
  const localValue = new Date(minimum.getTime() - minimum.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
  $("expiresInput").min = localValue;
  if (!$("expiresInput").value) $("expiresInput").value = localValue;
}

function openClaimDialog(food) {
  selectedFoodId = food.id;
  $("claimFoodSummary").textContent = `${food.name} · ${food.servings} servings at ${food.location}.`;
  claimForm.reset();
  claimFormView.hidden = false;
  claimSuccessView.hidden = true;
  claimDialog.showModal();
  window.setTimeout(() => claimForm.elements.volunteerName.focus(), 0);
}

function claimFood(foodId, volunteerName, arrivalTime, contact) {
  const food = foods.find((item) => item.id === foodId);
  if (!food || !isAvailable(food)) {
    renderApp();
    showToast("This food listing has expired or was already claimed.", "error");
    return null;
  }

  const claimedAt = Date.now();
  const saved = performAction("Food claim", `${food.servings} meals claimed by ${volunteerName} · ${food.name}`, "claim", (current) =>
    current.map((item) => item.id === food.id
      ? { ...item, claimed: true, volunteerName, arrivalTime, contact, claimedAt }
      : item)
  );
  return saved ? { food: clone(food), volunteerName, arrivalTime, claimedAt } : null;
}

foodForm.addEventListener("submit", (event) => {
  event.preventDefault();
  if (!foodForm.reportValidity()) return;

  const data = new FormData(foodForm);
  const name = String(data.get("name") || "").trim();
  const location = String(data.get("location") || "").trim();
  const servings = Number(data.get("servings"));
  const expiryValue = String(data.get("expiresAt") || "");
  const expiresAt = new Date(expiryValue).getTime();

  if (!name || !location || !Number.isInteger(servings) || servings <= 0 ||
      !Number.isFinite(expiresAt) || expiresAt <= Date.now()) {
    showToast("Please complete the required fields and choose a future pickup deadline.", "error");
    return;
  }

  const newFood = {
    id: `food-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    name,
    location,
    servings,
    expiresAt,
    description: String(data.get("description") || "").trim(),
    category: String(data.get("category") || "Meal"),
    foodType: String(data.get("foodType") || "Vegetarian"),
    claimed: false,
    volunteerName: "",
    arrivalTime: "",
    contact: "",
    createdAt: Date.now()
  };
  const success = performAction("New food post", `🟢 ${newFood.name} posted at ${newFood.location}`, "post", (current) => [newFood, ...current]);
  if (success) {
    foodForm.reset();
    updateExpiryInput();
    showToast("🌱 Surplus food posted successfully!");
    $("food-board").scrollIntoView({ behavior: "smooth", block: "start" });
  }
});

foodGrid.addEventListener("click", (event) => {
  const clearButton = event.target.closest(".empty-clear");
  if (clearButton) {
    clearSavedData();
    return;
  }

  const button = event.target.closest("[data-claim-id]");
  if (!button || button.disabled) return;
  const food = foods.find((item) => item.id === button.dataset.claimId);
  if (!food || !isAvailable(food)) {
    renderApp();
    showToast("This food listing is no longer available.", "error");
    return;
  }
  openClaimDialog(food);
});

claimForm.addEventListener("submit", (event) => {
  event.preventDefault();
  if (!claimForm.reportValidity()) return;
  const currentFood = foods.find((item) => item.id === selectedFoodId);
  if (!currentFood || !isAvailable(currentFood)) {
    claimDialog.close();
    showToast("This food listing has expired or was already claimed.", "error");
    renderApp();
    return;
  }

  const data = new FormData(claimForm);
  const volunteerName = String(data.get("volunteerName") || "").trim();
  const arrivalTime = String(data.get("arrivalTime") || "");
  const contact = String(data.get("contact") || "").trim();
  if (!volunteerName || !arrivalTime) {
    showToast("Please enter your name and estimated arrival time.", "error");
    return;
  }

  const claim = claimFood(selectedFoodId, volunteerName, arrivalTime, contact);
  if (!claim) return;
  const { food, claimedAt } = claim;

  $("rescueReceipt").innerHTML = `<div><span>🍛 Food</span><strong>${escapeHtml(food.name)}</strong></div><div><span>📍 Pickup</span><strong>${escapeHtml(food.location)}</strong></div><div><span>👥 Servings</span><strong>${food.servings}</strong></div><div><span>🙋 Volunteer</span><strong>${escapeHtml(volunteerName)}</strong></div><div><span>⏰ Arrival</span><strong>${escapeHtml(arrivalTime)}</strong></div><div><span>🕒 Claimed</span><strong>${formatClock(claimedAt)}</strong></div>`;
  claimFormView.hidden = true;
  claimSuccessView.hidden = false;
  showToast("🤝 Food rescue claimed! Thanks for making it happen.");
});

$("undoButton").addEventListener("click", undoLastAction);
searchInput.addEventListener("input", renderBoard);
document.querySelectorAll(".filter-button").forEach((button) => {
  button.addEventListener("click", () => {
    currentFilter = button.dataset.filter;
    document.querySelectorAll(".filter-button").forEach((item) => item.classList.toggle("active", item === button));
    renderBoard();
  });
});

function closeClaimDialog() {
  if (claimDialog.open) claimDialog.close();
  selectedFoodId = null;
  claimForm.reset();
  claimFormView.hidden = false;
  claimSuccessView.hidden = true;
}

$("closeClaim").addEventListener("click", closeClaimDialog);
$("closeSuccess").addEventListener("click", closeClaimDialog);
claimDialog.addEventListener("click", (event) => {
  if (event.target === claimDialog) closeClaimDialog();
});
claimDialog.addEventListener("close", () => {
  selectedFoodId = null;
  claimFormView.hidden = false;
  claimSuccessView.hidden = true;
});

const menuToggle = $("menuToggle");
const navLinks = $("navLinks");
menuToggle.addEventListener("click", () => {
  const isOpen = navLinks.classList.toggle("open");
  menuToggle.setAttribute("aria-expanded", String(isOpen));
  menuToggle.setAttribute("aria-label", isOpen ? "Close navigation menu" : "Open navigation menu");
});
navLinks.addEventListener("click", (event) => {
  if (event.target.closest("a")) {
    navLinks.classList.remove("open");
    menuToggle.setAttribute("aria-expanded", "false");
    menuToggle.setAttribute("aria-label", "Open navigation menu");
  }
});

$("demoButton").addEventListener("click", () => {
  clearSavedData();
  $("food-board").scrollIntoView({ behavior: "smooth", block: "start" });
});

renderApp();
initializeLucideIcons();
updateExpiryInput();
window.setInterval(() => {
  const changed = updateCountdowns();
  if (changed) {
    updateStatistics();
    updateCampusMap();
  }
}, 1000);
window.setInterval(rotateTicker, 3800);
