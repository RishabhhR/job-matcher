// Elements
const form = document.getElementById("matcher-form");
const cvTextInput = document.getElementById("cvText");
const uploadBtn = document.getElementById("upload-cv-btn");
const fileInput = document.getElementById("cv-file-input");
const targetDesignationInput = document.getElementById("targetDesignation");
const currentEmployerInput = document.getElementById("currentEmployer");
const currentTitleInput = document.getElementById("currentTitle");
const currentSalaryFixedInput = document.getElementById("currentSalaryFixed");
const currentSalaryEsopInput = document.getElementById("currentSalaryEsop");
const currentSalaryCurrencyInput = document.getElementById("currentSalaryCurrency");
const preferredCountryInput = document.getElementById("preferredCountry");
const preferredCityInput = document.getElementById("preferredCity");
const careerStartDateInput = document.getElementById("careerStartDate");
const greenhouseInput = document.getElementById("greenhouseCompanies");
const leverInput = document.getElementById("leverCompanies");
const ashbyInput = document.getElementById("ashbyCompanies");
const linkedinLocationInput = document.getElementById("linkedinLocation");
const linkedinMaxResultsInput = document.getElementById("linkedinMaxResults");

const digestEnabledInput = document.getElementById("digestEnabled");
const digestHourInput = document.getElementById("digestHour");
const authContainer = document.getElementById("auth-container");
const appContainer = document.getElementById("app-container");
const userProfileHeader = document.getElementById("user-profile-header");
const userNameLabel = document.getElementById("user-name-label");
const navAvatar = document.getElementById("nav-avatar");
const logoutBtn = document.getElementById("logout-btn");
const feedSearchInput = document.getElementById("feed-search-input");

const submitBtn = document.getElementById("submit-btn");
const statusBadge = document.getElementById("status-badge");
const terminalBody = document.getElementById("terminal-body");
const progressContainer = document.getElementById("progress-container");
const progressBar = document.getElementById("progress-bar");
const progressPercent = document.getElementById("progress-percent");
const resultsCountContainer = document.getElementById("results-count-container");
const resultsCount = document.getElementById("results-count");
const resultsGrid = document.getElementById("results-grid");
const paginationControls = document.getElementById("pagination-controls");
const prevPageBtn = document.getElementById("prev-page-btn");
const nextPageBtn = document.getElementById("next-page-btn");
const currentPageLabel = document.getElementById("current-page");
const totalPagesLabel = document.getElementById("total-pages");

// Pagination State
let currentUserId = null;
let currentPage = 1;
let totalMatchesCount = 0;
const limitPerPage = 10;
let clerkUser = null;

// --- Wizard Step Navigation ---
const stepPanels = document.querySelectorAll(".wizard-step");
const stepperNavButtons = document.querySelectorAll(".stepper-step");
let furthestStepReached = "profile";
const stepOrder = ["profile", "preferences", "results"];

function showStep(stepName) {
  stepPanels.forEach(panel => {
    panel.classList.toggle("active", panel.dataset.stepPanel === stepName);
  });
  stepperNavButtons.forEach(btn => {
    const isCurrent = btn.dataset.step === stepName;
    const isPast = stepOrder.indexOf(btn.dataset.step) < stepOrder.indexOf(stepName);
    btn.classList.toggle("active", isCurrent);
    btn.classList.toggle("complete", isPast);
  });
  if (stepOrder.indexOf(stepName) > stepOrder.indexOf(furthestStepReached)) {
    furthestStepReached = stepName;
  }
  document.getElementById("stepper-nav-results").disabled = stepOrder.indexOf(furthestStepReached) < stepOrder.indexOf("results");
  window.scrollTo({ top: 0, behavior: "smooth" });
}

document.getElementById("continue-to-preferences-btn").addEventListener("click", () => {
  const requiredIds = ["cvText", "targetDesignation", "currentEmployer", "currentTitle", "currentSalaryFixed", "currentSalaryEsop", "currentSalaryCurrency"];
  for (const id of requiredIds) {
    const el = document.getElementById(id);
    if (!el.reportValidity()) return;
  }
  showStep("preferences");
});

document.getElementById("back-to-profile-btn").addEventListener("click", () => showStep("profile"));
document.getElementById("back-to-preferences-btn").addEventListener("click", () => {
  document.getElementById("search-card-toggle").classList.add("expanded");
  document.getElementById("search-card-body").classList.add("expanded");
  showStep("preferences");
});

stepperNavButtons.forEach(btn => {
  btn.addEventListener("click", () => {
    if (btn.disabled) return;
    if (stepOrder.indexOf(btn.dataset.step) <= stepOrder.indexOf(furthestStepReached)) {
      showStep(btn.dataset.step);
    }
  });
});

// --- Collapsible sections ---
function wireCollapsible(toggleId, bodyId, startOpen = false) {
  const toggle = document.getElementById(toggleId);
  const body = document.getElementById(bodyId);
  if (startOpen) {
    toggle.classList.add("expanded");
    body.classList.add("expanded");
  }
  toggle.addEventListener("click", () => {
    toggle.classList.toggle("expanded");
    body.classList.toggle("expanded");
  });
}
wireCollapsible("paste-text-toggle", "paste-text-body");
wireCollapsible("compensation-toggle", "compensation-body");
wireCollapsible("ats-toggle", "ats-body");
wireCollapsible("search-card-toggle", "search-card-body", true);
wireCollapsible("run-logs-toggle", "run-logs-body");

function collapseSearchCard() {
  document.getElementById("search-card-toggle").classList.remove("expanded");
  document.getElementById("search-card-body").classList.remove("expanded");
}

// --- Live client-side filter over the always-visible match feed ---
feedSearchInput.addEventListener("input", () => {
  const query = feedSearchInput.value.trim().toLowerCase();
  document.querySelectorAll("#results-grid .result-card").forEach(card => {
    card.classList.toggle("hidden", query.length > 0 && !card.textContent.toLowerCase().includes(query));
  });
});

// --- Digest hour visibility follows the toggle ---
function syncDigestHourVisibility() {
  document.getElementById("digest-hour-group").classList.toggle("hidden", !document.getElementById("digestEnabled").checked);
}
document.getElementById("digestEnabled").addEventListener("change", syncDigestHourVisibility);
syncDigestHourVisibility();

// --- Drag-and-drop for CV upload ---
const cvDropzone = document.getElementById("cv-dropzone");
["dragenter", "dragover"].forEach(evt => {
  cvDropzone.addEventListener(evt, (e) => {
    e.preventDefault();
    cvDropzone.classList.add("dragover");
  });
});
["dragleave", "drop"].forEach(evt => {
  cvDropzone.addEventListener(evt, (e) => {
    e.preventDefault();
    cvDropzone.classList.remove("dragover");
  });
});
cvDropzone.addEventListener("drop", (e) => {
  const file = e.dataTransfer.files[0];
  if (file) {
    fileInput.files = e.dataTransfer.files;
    fileInput.dispatchEvent(new Event("change"));
  }
});

// Clerk Auth Initialization Handler
window.addEventListener("load", async () => {
  addLogLine("system", "Connecting to authentication service...");
  if (typeof window.Clerk === "undefined") {
    let retries = 0;
    const interval = setInterval(async () => {
      retries++;
      if (typeof window.Clerk !== "undefined") {
        clearInterval(interval);
        await initClerk();
      } else if (retries > 30) {
        clearInterval(interval);
        addLogLine("error", "Clerk failed to load. Please verify your internet connection.");
      }
    }, 200);
  } else {
    await initClerk();
  }
});

async function initClerk() {
  try {
    await window.Clerk.load();
    if (window.Clerk.user) {
      clerkUser = window.Clerk.user;
      showApp();
      await initializeUserData();
    } else {
      showLogin();
    }
  } catch (err) {
    console.error("Clerk initialization error:", err);
    addLogLine("error", "Authentication error: " + err.message);
  }
}

// Attaches the current Clerk session token (if signed in) as a Bearer header.
// The server verifies this token independently - it does NOT trust any clerkId
// sent in the request body alone, so this is required for /api/user/init,
// /api/match, and /api/match/page to succeed once a user is signed in.
async function authFetch(url, options = {}) {
  const headers = { "Content-Type": "application/json", ...(options.headers || {}) };
  if (window.Clerk && window.Clerk.session) {
    const token = await window.Clerk.session.getToken();
    if (token) headers.Authorization = `Bearer ${token}`;
  }
  return fetch(url, { ...options, headers });
}

function showLogin() {
  authContainer.classList.remove("hidden");
  appContainer.classList.add("hidden");
  window.Clerk.mountSignIn(authContainer, {
    afterSignInUrl: window.location.href,
  });
}

function showApp() {
  authContainer.classList.add("hidden");
  appContainer.classList.remove("hidden");
  userProfileHeader.classList.remove("hidden");
  const displayName = clerkUser.fullName || clerkUser.primaryEmailAddress.emailAddress;
  userNameLabel.textContent = `Hello, ${displayName}!`;
  navAvatar.textContent = getInitials(displayName);
  updateRails();
}

function getInitials(name) {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  const initials = parts.length === 1 ? parts[0][0] : parts[0][0] + parts[parts.length - 1][0];
  return initials.toUpperCase();
}

logoutBtn.addEventListener("click", async () => {
  await window.Clerk.signOut();
  window.location.reload();
});

async function initializeUserData() {
  addLogLine("system", "Loading profile and email preferences...");
  try {
    const response = await authFetch("/api/user/init", {
      method: "POST",
      body: JSON.stringify({})
    });

    if (!response.ok) throw new Error("Failed to sync profile settings with backend.");
    const data = await response.json();
    currentUserId = data.userId;

    if (data.cvText) {
      cvTextInput.value = data.cvText;
      const pasteToggle = document.getElementById("paste-text-toggle");
      const pasteBody = document.getElementById("paste-text-body");
      if (pasteToggle && pasteBody) {
        pasteToggle.classList.add("expanded");
        pasteBody.classList.add("expanded");
      }
    }
    if (data.profile) {
      targetDesignationInput.value = data.profile.targetDesignation || "";
      currentEmployerInput.value = data.profile.currentEmployer || "";
      currentTitleInput.value = data.profile.currentTitle || "";
      currentSalaryFixedInput.value = data.profile.currentSalaryFixedLPA || "";
      currentSalaryEsopInput.value = data.profile.currentSalaryEsopLPA || "";
      currentSalaryCurrencyInput.value = data.profile.currentSalaryCurrency || "INR";
      preferredCountryInput.value = data.profile.preferredCountry || "";
      preferredCityInput.value = data.profile.preferredCity || "";
      careerStartDateInput.value = data.profile.careerStartDate || "";
    }

    // Per-user company sources are stored with the account. A new account gets
    // the public baseline seed returned by /api/user/init.
    if (data.companies) {
      greenhouseInput.value = Array.isArray(data.companies.greenhouse) ? data.companies.greenhouse.join(", ") : "";
      leverInput.value = Array.isArray(data.companies.lever) ? data.companies.lever.join(", ") : "";
      ashbyInput.value = Array.isArray(data.companies.ashby) ? data.companies.ashby.join(", ") : "";
    }

    if (data.digestSettings) {
      digestEnabledInput.checked = data.digestSettings.digestEnabled;
      digestHourInput.value = data.digestSettings.digestHour.toString();
    }

    addLogLine("success", "Settings prefilled and database session initialized.");
    
    // Automatically load existing matched job roles for the user, if any
    currentPage = 1;
    await fetchMatchesPage(currentPage);
    updateRails();
  } catch (error) {
    addLogLine("error", "Sync error: " + error.message);
  }
}

// Upload CV handler
uploadBtn.addEventListener("click", () => {
  fileInput.click();
});

fileInput.addEventListener("change", async (e) => {
  const file = e.target.files[0];
  if (!file) return;

  const originalBtnText = uploadBtn.innerHTML;
  uploadBtn.disabled = true;
  uploadBtn.innerHTML = `
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="margin-right: 4px; vertical-align: middle; animation: spin 1s linear infinite;"><path d="M21.5 2v6h-6M21.34 15.57a10 10 0 1 1-.57-8.38l5.67-5.67"/></svg>
    Parsing...
  `;
  addLogLine("system", `Uploading and parsing CV file: ${file.name}...`);

  const reader = new FileReader();
  reader.onload = async () => {
    try {
      const base64Data = reader.result.split(",")[1];
      const res = await authFetch("/api/upload-cv", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          fileName: file.name,
          fileType: file.type,
          fileData: base64Data
        })
      });

      if (!res.ok) {
        const errorData = await res.json();
        throw new Error(errorData.error || "Failed to parse CV");
      }

      const data = await res.json();
      cvTextInput.value = data.text;
      addLogLine("success", `Successfully parsed and loaded resume text (${data.text.length} characters).`);
    } catch (err) {
      addLogLine("error", `CV Upload Error: ${err.message}`);
      alert(`Failed to upload/parse CV: ${err.message}`);
    } finally {
      uploadBtn.disabled = false;
      uploadBtn.innerHTML = originalBtnText;
      fileInput.value = ""; // Reset file selector
    }
  };

  reader.onerror = () => {
    addLogLine("error", "Failed to read local file.");
    uploadBtn.disabled = false;
    uploadBtn.innerHTML = originalBtnText;
    fileInput.value = "";
  };

  reader.readAsDataURL(file);
});

// Terminal Logger helper
function addLogLine(type, text) {
  const line = document.createElement("div");
  line.className = `log-line ${type}`;
  line.textContent = `[${new Date().toLocaleTimeString()}] ${text}`;
  terminalBody.appendChild(line);
  terminalBody.scrollTop = terminalBody.scrollHeight;
}

// Progress calculations based on statuses
function updateProgress(status, message) {
  let percent = 0;
  switch (status) {
    case "scraping_ats":
      percent = 10;
      break;
    case "scraping_ats_complete":
      percent = 25;
      break;
    case "scraping_linkedin":
      percent = 35;
      break;
    case "scraping_linkedin_complete":
      percent = 55;
      break;
    case "processing":
      percent = 65;
      break;
    case "scoring":
      percent = 75;
      // Parse batch progress if available, e.g. "Scoring batch 2/4" -> adjust percentage
      const match = message.match(/batch (\d+)\/(\d+)/i);
      if (match) {
        const current = parseInt(match[1]);
        const total = parseInt(match[2]);
        percent = 75 + Math.floor((current / total) * 20); // 75% to 95%
      }
      break;
    case "complete":
      percent = 100;
      break;
    default:
      percent = 0;
  }
  
  progressBar.style.width = `${percent}%`;
  progressPercent.textContent = `${percent}%`;
}

// Form Submission Handler
form.addEventListener("submit", async (e) => {
  e.preventDefault();

  showStep("results");

  // Reset UI state
  terminalBody.innerHTML = "";
  resultsGrid.innerHTML = "";
  resultsCountContainer.classList.add("hidden");
  progressContainer.classList.remove("hidden");
  progressBar.style.width = "0%";
  progressPercent.textContent = "0%";
  
  statusBadge.className = "status-badge running";
  statusBadge.textContent = "Running";
  submitBtn.classList.add("loading");
  submitBtn.disabled = true;

  addLogLine("system", "Initializing match pipeline...");

  // Parse comma-separated list of companies
  const parseList = (str) => str.split(",").map(item => item.trim()).filter(Boolean);

  const payload = {
    cvText: cvTextInput.value,
    profile: {
      targetDesignation: targetDesignationInput.value,
      currentEmployer: currentEmployerInput.value,
      currentTitle: currentTitleInput.value,
      currentSalaryFixedLPA: parseFloat(currentSalaryFixedInput.value),
      currentSalaryEsopLPA: parseFloat(currentSalaryEsopInput.value),
      currentSalaryCurrency: currentSalaryCurrencyInput.value,
      preferredCountry: preferredCountryInput.value || undefined,
      preferredCity: preferredCityInput.value || undefined,
      careerStartDate: careerStartDateInput.value || undefined,
    },
    companies: {
      greenhouse: parseList(greenhouseInput.value),
      lever: parseList(leverInput.value),
      ashby: parseList(ashbyInput.value),
    },
    linkedin: {
      location: linkedinLocationInput.value || "India",
      maxResults: parseInt(linkedinMaxResultsInput.value) || 100,
    },
    digestEnabled: digestEnabledInput.checked,
    digestHour: parseInt(digestHourInput.value)
  };

  try {
    const response = await authFetch("/api/match", {
      method: "POST",
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      const errData = await response.json();
      throw new Error(errData.error || "Failed to trigger match execution.");
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    while (true) {
      const { value, done } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const parts = buffer.split("\n\n");
      buffer = parts.pop(); // Keep last partial chunk

      for (const chunk of parts) {
        if (!chunk.trim()) continue;

        let event = "";
        let data = {};

        const lines = chunk.split("\n");
        for (const line of lines) {
          if (line.startsWith("event:")) {
            event = line.replace("event:", "").trim();
          } else if (line.startsWith("data:")) {
            try {
              data = JSON.parse(line.replace("data:", "").trim());
            } catch (e) {
              console.error("Failed to parse event JSON data", e);
            }
          }
        }

        handleSSEEvent(event, data);
      }
    }
  } catch (error) {
    addLogLine("error", "Fatal Match Execution Error: " + error.message);
    statusBadge.className = "status-badge error";
    statusBadge.textContent = "Error";
    submitBtn.classList.remove("loading");
    submitBtn.disabled = false;
  }
});

// Event Handler for SSE stream
function handleSSEEvent(event, data) {
  if (event === "progress") {
    let logType = "info";
    if (data.status === "complete" || data.status === "scraping_ats_complete" || data.status === "scraping_linkedin_complete") {
      logType = "success";
    } else if (data.status === "complete" && data.message.includes("No postings")) {
      logType = "warning";
    }
    
    addLogLine(logType, data.message);
    updateProgress(data.status, data.message);
  } else if (event === "done") {
    addLogLine("success", "Pipeline execution finished successfully.");
    statusBadge.className = "status-badge complete";
    statusBadge.textContent = "Complete";
    submitBtn.classList.remove("loading");
    submitBtn.disabled = false;
    
    currentUserId = data.userId;
    totalMatchesCount = data.totalMatches;
    currentPage = 1;

    renderResults(data.results);
    updatePaginationControls();
    collapseSearchCard();
  } else if (event === "error") {
    addLogLine("error", "Error during execution: " + data.message);
    statusBadge.className = "status-badge error";
    statusBadge.textContent = "Error";
    submitBtn.classList.remove("loading");
    submitBtn.disabled = false;
  }
}

// Render matches to the DOM
function renderResults(results) {
  resultsGrid.innerHTML = "";
  if (!results || results.length === 0) {
    resultsCountContainer.classList.add("hidden");
    paginationControls.classList.add("hidden");
    const emptyMsg = document.createElement("div");
    emptyMsg.className = "log-line warning";
    emptyMsg.textContent = "No scored job matches met the current filtering criteria.";
    resultsGrid.appendChild(emptyMsg);
    return;
  }

  const startIdx = (currentPage - 1) * limitPerPage + 1;
  const endIdx = Math.min(currentPage * limitPerPage, totalMatchesCount);
  resultsCount.textContent = `showing ${startIdx}-${endIdx} of ${totalMatchesCount}`;
  resultsCountContainer.classList.remove("hidden");

  results.forEach(m => {
    const card = document.createElement("div");
    card.className = "result-card";

    let scoreClass = "low";
    if (m.fitScore >= 75) scoreClass = "high";
    else if (m.fitScore >= 45) scoreClass = "medium";

    card.innerHTML = `
      <div class="result-card-header">
        <div class="job-title-company">
          <h4>${escapeHTML(m.posting.title)}</h4>
          <span class="job-company">${escapeHTML(m.posting.company)}</span>
        </div>
        <div class="score-badge ${scoreClass}">
          <span>${m.fitScore}</span>
          <span class="score-lbl">fit</span>
        </div>
      </div>
      
      <div class="result-card-meta">
        <span class="meta-tag source">${escapeHTML(m.posting.source)}</span>
        <span class="meta-tag ${m.compFitLabel}">${escapeHTML(m.compFitLabel)}</span>
        ${m.posting.location ? `<span class="meta-tag">${escapeHTML(m.posting.location)}</span>` : ""}
        ${(() => {
          const dateValue = m.posting.postedAt || m.posting.scrapedAt;
          const date = dateValue ? new Date(dateValue) : null;
          if (!date || Number.isNaN(date.getTime())) return "";
          const label = !m.posting.postedAt
            ? "Found"
            : m.posting.source === "greenhouse" ? "Updated" : "Posted";
          return `<span class="meta-tag">${label} ${escapeHTML(date.toLocaleDateString())}</span>`;
        })()}
      </div>
      
      <p class="reasoning">${escapeHTML(m.reasoningText)}</p>
      
      <a href="${m.posting.applyUrl}" target="_blank" rel="noopener noreferrer" class="apply-link">
        Apply Now ↗
      </a>
    `;

    resultsGrid.appendChild(card);
  });
}

function updatePaginationControls() {
  const totalPages = Math.ceil(totalMatchesCount / limitPerPage);
  
  if (totalPages <= 1) {
    paginationControls.classList.add("hidden");
    return;
  }
  
  paginationControls.classList.remove("hidden");
  currentPageLabel.textContent = currentPage;
  totalPagesLabel.textContent = totalPages;
  
  prevPageBtn.disabled = currentPage === 1;
  nextPageBtn.disabled = currentPage === totalPages;
}

async function goToPage(page) {
  const totalPages = Math.ceil(totalMatchesCount / limitPerPage);
  if (page < 1 || page > totalPages) return;
  
  currentPage = page;
  updatePaginationControls();
  
  // Set UI to loading state
  resultsGrid.innerHTML = `
    <div class="log-line system" style="text-align: center; padding: 2rem;">
      <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="animation: spin 1s linear infinite; margin-bottom: 8px;"><path d="M21.5 2v6h-6M21.34 15.57a10 10 0 1 1-.57-8.38l5.67-5.67"/></svg>
      <div>Fetching and scoring matches for Page ${currentPage}...</div>
    </div>
  `;
  
  addLogLine("system", `Fetching descriptions and scoring matches for Page ${currentPage}...`);
  
  try {
    const res = await authFetch("/api/match/page", {
      method: "POST",
      body: JSON.stringify({
        userId: currentUserId,
        page: currentPage,
        limit: limitPerPage
      })
    });
    
    if (!res.ok) {
      const errorData = await res.json();
      throw new Error(errorData.error || "Failed to load page results.");
    }
    
    const data = await res.json();
    addLogLine("success", `Successfully scored and rendered Page ${currentPage}.`);
    renderResults(data.results);
  } catch (error) {
    addLogLine("error", `Page Load Error: ${error.message}`);
    resultsGrid.innerHTML = `
      <div class="log-line error" style="text-align: center; padding: 2rem;">
        Error loading page ${currentPage}: ${error.message}
      </div>
    `;
  }
}

// Pagination Event Listeners
prevPageBtn.addEventListener("click", () => goToPage(currentPage - 1));
nextPageBtn.addEventListener("click", () => goToPage(currentPage + 1));

// --- Navigation Tab Toggles ---
const navBtnWizard = document.getElementById("nav-btn-wizard");
const navBtnSettings = document.getElementById("nav-btn-settings");
const viewWizard = document.getElementById("view-wizard");
const viewSettings = document.getElementById("view-settings");

navBtnWizard.addEventListener("click", () => {
  navBtnWizard.classList.add("active");
  navBtnSettings.classList.remove("active");
  viewWizard.classList.remove("hidden");
  viewSettings.classList.add("hidden");
  updateRails();
});

navBtnSettings.addEventListener("click", async () => {
  navBtnWizard.classList.remove("active");
  navBtnSettings.classList.add("active");
  viewWizard.classList.add("hidden");
  viewSettings.classList.remove("hidden");

  // Sync inputs
  document.getElementById("settings-digest-enabled").checked = document.getElementById("digestEnabled").checked;
  document.getElementById("settings-digest-hour").value = document.getElementById("digestHour").value;
  document.getElementById("settings-digest-hour-group").classList.toggle("hidden", !document.getElementById("digestEnabled").checked);

  // Populate candidate quick-info
  document.getElementById("readonly-target-title").textContent = document.getElementById("targetDesignation").value || "Not set";
  document.getElementById("readonly-current-employer").textContent = document.getElementById("currentEmployer").value || "Not set";

  // Fetch stats and update charts/metrics
  await fetchAndRenderStats();
});

// Shortcut button
document.getElementById("edit-profile-shortcut-btn").addEventListener("click", () => {
  navBtnWizard.click();
  showStep("profile");
});

// Sync inputs bi-directionally
document.getElementById("settings-digest-enabled").addEventListener("change", (e) => {
  document.getElementById("digestEnabled").checked = e.target.checked;
  document.getElementById("settings-digest-hour-group").classList.toggle("hidden", !e.target.checked);
});
document.getElementById("settings-digest-hour").addEventListener("change", (e) => {
  document.getElementById("digestHour").value = e.target.value;
});

// Settings Form Submission
const settingsForm = document.getElementById("settings-form");
settingsForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  const saveBtn = document.getElementById("save-settings-btn");
  const originalText = saveBtn.textContent;
  saveBtn.disabled = true;
  saveBtn.textContent = "Saving...";

  try {
    const res = await authFetch("/api/user/settings", {
      method: "POST",
      body: JSON.stringify({
        userId: currentUserId,
        digestEnabled: document.getElementById("settings-digest-enabled").checked,
        digestHour: parseInt(document.getElementById("settings-digest-hour").value, 10)
      })
    });

    if (!res.ok) {
      const err = await res.json();
      throw new Error(err.error || "Failed to save settings");
    }

    // Sync back to wizard inputs
    document.getElementById("digestEnabled").checked = document.getElementById("settings-digest-enabled").checked;
    document.getElementById("digestHour").value = document.getElementById("settings-digest-hour").value;
    
    // Also sync the wizard's timezone/hour groups visibility
    syncDigestHourVisibility();
    updateRails();

    alert("Settings saved successfully!");
  } catch (err) {
    alert("Error saving settings: " + err.message);
  } finally {
    saveBtn.disabled = false;
    saveBtn.textContent = originalText;
  }
});

async function fetchAndRenderStats() {
  if (!currentUserId) return;
  try {
    const res = await authFetch(`/api/user/stats?userId=${currentUserId}`);
    if (!res.ok) throw new Error("Failed to fetch statistics.");
    const stats = await res.json();

    // Populate metric cards
    document.getElementById("stat-avg-score").textContent = `${stats.averageFitScore}%`;
    document.getElementById("stat-total-scraped").textContent = stats.totalScraped;
    document.getElementById("stat-total-scored").textContent = stats.totalScored;

    // Calculate maximum count for percentages in the chart
    const maxCount = Math.max(stats.highMatchCount, stats.mediumMatchCount, stats.lowMatchCount, 1);
    
    const setBar = (barId, countId, count) => {
      const pct = (count / maxCount) * 100;
      document.getElementById(barId).style.width = `${pct}%`;
      document.getElementById(countId).textContent = count;
    };

    setBar("dist-bar-high", "dist-count-high", stats.highMatchCount);
    setBar("dist-bar-medium", "dist-count-medium", stats.mediumMatchCount);
    setBar("dist-bar-low", "dist-count-low", stats.lowMatchCount);

    // Render company list
    const companyListEl = document.getElementById("stat-company-list");
    companyListEl.innerHTML = "";
    if (stats.companyDistribution.length === 0) {
      companyListEl.innerHTML = `<li class="company-item empty">No listings scored yet.</li>`;
    } else {
      stats.companyDistribution.forEach(item => {
        const li = document.createElement("li");
        li.className = "company-item";
        li.innerHTML = `
          <span class="company-name">${escapeHTML(item.company)}</span>
          <span class="company-count">${item.count}</span>
        `;
        companyListEl.appendChild(li);
      });
    }
    updateRails();
  } catch (err) {
    console.error("Error fetching dashboard statistics:", err);
  }
}

function escapeHTML(str) {
  if (!str) return "";
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function updateRails() {
  if (!clerkUser) return;
  const displayName = clerkUser.fullName || clerkUser.primaryEmailAddress.emailAddress;

  // Left Rail: Profile Card
  const profileCardName = document.getElementById("profile-card-name");
  const profileCardHeadline = document.getElementById("profile-card-headline");
  const profileAvatar = document.getElementById("profile-avatar-placeholder");

  if (profileCardName) profileCardName.textContent = displayName;
  if (profileCardHeadline) {
    const designation = targetDesignationInput ? targetDesignationInput.value : "";
    const employer = currentEmployerInput ? currentEmployerInput.value : "";
    profileCardHeadline.textContent = (designation && employer) ? `${designation} @ ${employer}` : (designation || "Job Seeker");
  }
  if (profileAvatar) {
    if (clerkUser.imageUrl) {
      profileAvatar.textContent = "";
      profileAvatar.style.backgroundImage = `url(${clerkUser.imageUrl})`;
      profileAvatar.style.backgroundSize = "cover";
      profileAvatar.style.backgroundPosition = "center";
    } else {
      profileAvatar.textContent = getInitials(displayName);
      profileAvatar.style.backgroundImage = "none";
    }
  }

  // Left Rail: Profile Stats
  const matchesVal = document.getElementById("profile-stat-matches");
  const searchesVal = document.getElementById("profile-stat-searches");
  if (matchesVal) matchesVal.textContent = totalMatchesCount || 0;
  if (searchesVal) {
    const totalScrapedVal = document.getElementById("stat-total-scraped") ? document.getElementById("stat-total-scraped").textContent : "0";
    searchesVal.textContent = totalScrapedVal !== "0" ? totalScrapedVal : "0";
  }

  // Left Rail: Recent Activity
  const recentRole = document.getElementById("recent-activity-role");
  if (recentRole && targetDesignationInput && targetDesignationInput.value) {
    recentRole.textContent = `${targetDesignationInput.value} roles`;
  }

  // Right Rail: Daily Digest
  const railDigestDot = document.getElementById("rail-digest-status-dot");
  const railDigestDesc = document.getElementById("rail-digest-status-desc");
  if (railDigestDot && railDigestDesc) {
    const isEnabled = digestEnabledInput ? digestEnabledInput.checked : false;
    if (isEnabled) {
      railDigestDot.classList.add("active");
      const hour = parseInt(digestHourInput ? digestHourInput.value : "9", 10);
      const ampm = hour >= 12 ? "PM" : "AM";
      const displayHour = hour % 12 === 0 ? 12 : hour % 12;
      railDigestDesc.textContent = `Daily digest enabled at ${displayHour}:00 ${ampm}.`;
    } else {
      railDigestDot.classList.remove("active");
      railDigestDesc.textContent = "Daily digest is disabled. Enable in Settings.";
    }
  }

  // Right Rail: Preferred Location
  const railLocation = document.getElementById("rail-location-text");
  if (railLocation) {
    const city = preferredCityInput ? preferredCityInput.value : "";
    const country = preferredCountryInput ? preferredCountryInput.value : "";
    if (city || country) {
      railLocation.textContent = [city, country].filter(Boolean).join(", ");
    } else {
      railLocation.textContent = "Not specified";
    }
  }

  // Right Rail: Target Companies
  const railCompaniesList = document.getElementById("rail-companies-list");
  if (railCompaniesList) {
    railCompaniesList.innerHTML = "";
    const list = [];
    const collect = (inputVal, iconChar) => {
      if (inputVal) {
        inputVal.split(",").map(s => s.trim()).filter(Boolean).forEach(c => {
          list.push({ name: c, icon: iconChar });
        });
      }
    };
    if (greenhouseInput) collect(greenhouseInput.value, "G");
    if (leverInput) collect(leverInput.value, "L");
    if (ashbyInput) collect(ashbyInput.value, "A");

    if (list.length === 0) {
      railCompaniesList.innerHTML = '<li class="companies-empty-text">No target boards configured.</li>';
    } else {
      list.slice(0, 5).forEach(item => {
        const li = document.createElement("li");
        li.className = "rail-company-item";
        li.innerHTML = `
          <div class="rail-company-icon">${item.icon}</div>
          <span class="rail-company-name">${escapeHTML(item.name)}</span>
        `;
        railCompaniesList.appendChild(li);
      });
    }
  }
}

// Wire Left/Right Rail Click Handlers
document.addEventListener("click", (e) => {
  const shortcutMatches = e.target.closest("#shortcut-matches-btn");
  if (shortcutMatches) {
    const grid = document.getElementById("results-grid");
    if (grid) grid.scrollIntoView({ behavior: "smooth" });
    return;
  }

  const shortcutSearches = e.target.closest("#shortcut-searches-btn");
  if (shortcutSearches) {
    const settingsTab = document.getElementById("nav-btn-settings");
    if (settingsTab) settingsTab.click();
    return;
  }

  const recentRoles = e.target.closest("#recent-roles-btn");
  if (recentRoles) {
    const wizardTab = document.getElementById("nav-btn-wizard");
    if (wizardTab) wizardTab.click();
    const searchCardToggle = document.getElementById("search-card-toggle");
    const searchCardBody = document.getElementById("search-card-body");
    if (searchCardToggle && searchCardBody) {
      searchCardToggle.classList.add("expanded");
      searchCardBody.classList.add("expanded");
    }
    showStep("profile");
    return;
  }

  const recentCompanies = e.target.closest("#recent-companies-btn");
  if (recentCompanies) {
    const wizardTab = document.getElementById("nav-btn-wizard");
    if (wizardTab) wizardTab.click();
    const searchCardToggle = document.getElementById("search-card-toggle");
    const searchCardBody = document.getElementById("search-card-body");
    if (searchCardToggle && searchCardBody) {
      searchCardToggle.classList.add("expanded");
      searchCardBody.classList.add("expanded");
    }
    showStep("preferences");
    return;
  }
});
