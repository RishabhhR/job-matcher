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
const logoutBtn = document.getElementById("logout-btn");

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
      body: JSON.stringify({
        clerkId: clerkUser.id,
        email: clerkUser.primaryEmailAddress.emailAddress,
        name: clerkUser.fullName
      })
    });

    if (!response.ok) throw new Error("Failed to sync profile settings with backend.");
    const data = await response.json();
    currentUserId = data.userId;

    if (data.cvText) cvTextInput.value = data.cvText;
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

    // Prefill baseline companies
    const configRes = await fetch("/api/initial-data");
    if (configRes.ok) {
      const configData = await configRes.json();
      if (configData.companies) {
        greenhouseInput.value = Array.isArray(configData.companies.greenhouse) ? configData.companies.greenhouse.join(", ") : "";
        leverInput.value = Array.isArray(configData.companies.lever) ? configData.companies.lever.join(", ") : "";
        ashbyInput.value = Array.isArray(configData.companies.ashby) ? configData.companies.ashby.join(", ") : "";
      }
    }

    if (data.digestSettings) {
      digestEnabledInput.checked = data.digestSettings.digestEnabled;
      digestHourInput.value = data.digestSettings.digestHour.toString();
    }

    addLogLine("success", "Settings prefilled and database session initialized.");
    
    // Automatically load existing matched job roles for the user, if any
    currentPage = 1;
    await fetchMatchesPage(currentPage);
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
      const res = await fetch("/api/upload-cv", {
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
    clerkId: clerkUser ? clerkUser.id : undefined,
    email: clerkUser ? clerkUser.primaryEmailAddress.emailAddress : undefined,
    name: clerkUser ? clerkUser.fullName : undefined,
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

function escapeHTML(str) {
  if (!str) return "";
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}
