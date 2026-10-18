// First-run onboarding (TASK-057, antigravity).
// 3-step wizard: Upload CV -> Check what we found -> Where and when -> Find matches.
// On completion: store.set({ hasCv: true, cvText, profile, ... }) then navigate("matches").

export const title = "Get started";

export async function render(root, { store, api, ui, navigate }) {
  let step = 1;
  let isUploading = false;
  let isPasting = false;
  let cvFileName = "";
  let cvText = store.get().cvText || "";
  
  // Profile defaults (pre-populated or inferred from CV)
  let targetRole = "Product Manager";
  let currentTitle = "Associate Product Manager";
  let currentEmployer = "Zepto";
  let careerStartDate = "Jul 2024";
  let skills = ["product management", "growth", "experimentation", "SQL"];
  let salaryFixed = "";
  let salaryEsop = "";
  let salaryCurrency = "INR";
  
  // Search & digest defaults
  let locations = ["Bengaluru", "Remote"];
  let remoteActive = true;
  let digestEnabled = true;
  let digestHour = 9;

  function inferProfileFromText(text) {
    if (!text) return;
    const lower = text.toLowerCase();
    if (lower.includes("software engineer") || lower.includes("developer")) {
      targetRole = "Software Engineer";
      currentTitle = "Software Engineer";
    } else if (lower.includes("product manager") || lower.includes("apm") || lower.includes("associate product manager")) {
      targetRole = "Product Manager";
      currentTitle = "Associate Product Manager";
    }
    const detected = [];
    const candidates = [
      "growth", "experimentation", "sql", "python", "pricing", "analytics",
      "fintech", "quick commerce", "consumer", "logistics", "ai", "b2b"
    ];
    for (const c of candidates) {
      if (lower.includes(c) && !detected.includes(c)) detected.push(c);
    }
    if (detected.length >= 3) {
      skills = detected.slice(0, 6);
    }
  }

  function renderStep() {
    if (step === 1) renderStep1();
    else if (step === 2) renderStep2();
    else if (step === 3) renderStep3();
    
    const h1 = root.querySelector("h1");
    if (h1) {
      h1.setAttribute("tabindex", "-1");
      h1.focus({ preventScroll: true });
    }
    ui.announce(`Step ${step} of 3`);
  }

  function renderStep1() {
    root.innerHTML = ui.html`
      <div class="page"><div class="onb-wrap">
        <div class="onb-header">
          <p class="onb-step-tag">Step 1 of 3</p>
          <h1>Let's find jobs that fit you</h1>
          <p>Upload your CV and we'll read your experience, then check job boards twice a day for roles that match.</p>
        </div>

        <div class="onb-progress" aria-hidden="true">
          <div class="onb-progress-bar is-active"></div>
          <div class="onb-progress-bar"></div>
          <div class="onb-progress-bar"></div>
        </div>

        <div class="onb-dropzone" id="onb-dropzone" role="button" tabindex="0" aria-label="Drop your CV here or click to choose file">
          <input type="file" id="onb-file-input" accept=".pdf,.docx,.txt" hidden>
          <div class="onb-drop-icon" aria-hidden="true">↑</div>
          <h2>${isUploading ? "Reading your CV…" : "Drop your CV here"}</h2>
          <p class="muted">${isUploading ? "Extracting text and structure…" : "PDF, DOCX or TXT, up to 5 MB"}</p>
          <button type="button" class="btn btn-primary" id="onb-choose-btn" ${isUploading ? "disabled" : ""}>
            ${isUploading ? "Uploading…" : "Choose a file"}
          </button>
          
          <div style="margin-top: 14px;">
            <button type="button" class="link-btn" id="onb-paste-toggle">
              ${isPasting ? "Hide text paste" : "Paste text instead"}
            </button>
          </div>
        </div>

        ${isPasting ? ui.html`
          <div class="onb-paste-box card card-pad" style="margin-top: 16px;">
            <label for="onb-paste-area" class="label">Paste your CV or resume text</label>
            <textarea id="onb-paste-area" class="textarea" placeholder="Paste resume content here...">${cvText}</textarea>
            <div style="display:flex; justify-content:flex-end; margin-top: 12px;">
              <button type="button" class="btn btn-primary" id="onb-paste-submit">Continue with text</button>
            </div>
          </div>
        ` : ""}

        <div class="onb-privacy-note">
          <span aria-hidden="true">🔒</span>
          <span>Your CV is only used to score jobs for you. Contact details are never shown or shared.</span>
        </div>

        <div class="onb-footer">
          <span class="muted">Next: check what we found</span>
          <button type="button" class="btn btn-ghost" id="onb-skip-btn" ${!cvText.trim() ? "disabled" : ""}>
            Continue →
          </button>
        </div>
      </div></div>
    `;

    const dropzone = root.querySelector("#onb-dropzone");
    const fileInput = root.querySelector("#onb-file-input");
    const chooseBtn = root.querySelector("#onb-choose-btn");
    const pasteToggle = root.querySelector("#onb-paste-toggle");
    const skipBtn = root.querySelector("#onb-skip-btn");

    const handleFile = async (file) => {
      if (!file) return;
      isUploading = true;
      cvFileName = file.name;
      renderStep1();
      try {
        const res = await api.uploadCv(file);
        cvText = res.text || "";
        inferProfileFromText(cvText);
        ui.toast({ message: "CV uploaded successfully!" });
        step = 2;
        renderStep();
      } catch (err) {
        console.error(err);
        isUploading = false;
        renderStep1();
        ui.toast({ message: err.message || "Failed to read CV file" });
      }
    };

    dropzone.addEventListener("dragover", (e) => {
      e.preventDefault();
      dropzone.classList.add("is-dragover");
    });
    dropzone.addEventListener("dragleave", () => {
      dropzone.classList.remove("is-dragover");
    });
    dropzone.addEventListener("drop", (e) => {
      e.preventDefault();
      dropzone.classList.remove("is-dragover");
      if (e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0]) {
        handleFile(e.dataTransfer.files[0]);
      }
    });

    chooseBtn.addEventListener("click", () => fileInput.click());
    fileInput.addEventListener("change", (e) => {
      if (e.target.files && e.target.files[0]) {
        handleFile(e.target.files[0]);
      }
    });

    pasteToggle.addEventListener("click", () => {
      isPasting = !isPasting;
      renderStep1();
    });

    if (isPasting) {
      const pasteArea = root.querySelector("#onb-paste-area");
      const pasteSubmit = root.querySelector("#onb-paste-submit");
      pasteSubmit.addEventListener("click", () => {
        const val = pasteArea.value.trim();
        if (!val) {
          ui.toast({ message: "Please paste your resume text to continue." });
          return;
        }
        cvText = val;
        inferProfileFromText(cvText);
        step = 2;
        renderStep();
      });
    }

    if (skipBtn) {
      skipBtn.addEventListener("click", () => {
        if (cvText.trim()) {
          step = 2;
          renderStep();
        }
      });
    }
  }

  function renderStep2() {
    root.innerHTML = ui.html`
      <div class="page"><div class="onb-wrap">
        <div class="onb-header">
          <p class="onb-step-tag">Step 2 of 3</p>
          <h1>Check what we found</h1>
          <p>We read your experience and matched skills. Tweak anything that isn't quite right.</p>
        </div>

        <div class="onb-progress" aria-hidden="true">
          <div class="onb-progress-bar is-active"></div>
          <div class="onb-progress-bar is-active"></div>
          <div class="onb-progress-bar"></div>
        </div>

        <div class="card onb-card">
          <div class="field">
            <label for="step2-role">Target role</label>
            <input id="step2-role" class="input" value="${targetRole}" placeholder="e.g. Product Manager">
          </div>

          <div class="onb-grid-2">
            <div class="field">
              <label for="step2-title">Current or recent title</label>
              <input id="step2-title" class="input" value="${currentTitle}" placeholder="e.g. Associate PM">
            </div>
            <div class="field">
              <label for="step2-employer">Current or recent company</label>
              <input id="step2-employer" class="input" value="${currentEmployer}" placeholder="e.g. Zepto">
            </div>
          </div>

          <div class="field">
            <label for="step2-career-start">Career start date</label>
            <input id="step2-career-start" class="input" value="${careerStartDate}" placeholder="e.g. Jul 2024">
            <p class="hint">Used to estimate your years of experience for seniority caps.</p>
          </div>

          <div class="field">
            <label class="label">Matched skills</label>
            <div class="onb-tags-wrap" id="onb-skills-list">
              ${skills.map((s) => ui.html`
                <span class="chip-edit">
                  ${s}
                  <button type="button" data-remove-skill="${s}" aria-label="Remove skill ${s}">×</button>
                </span>
              `)}
              <div class="onb-add-tag-box">
                <input id="onb-new-skill" class="onb-add-tag-input" placeholder="+ Add skill">
                <button type="button" class="btn btn-ghost" id="onb-add-skill-btn" style="min-height:36px; padding: 0 10px; font-size:13px;">Add</button>
              </div>
            </div>
          </div>

          <details class="onb-details">
            <summary>Add current compensation (optional)</summary>
            <div class="onb-grid-2" style="margin-top: 14px;">
              <div class="field">
                <label for="step2-fixed">Fixed pay (LPA)</label>
                <input id="step2-fixed" class="input" value="${salaryFixed}" placeholder="e.g. 18">
              </div>
              <div class="field">
                <label for="step2-esop">ESOP (LPA)</label>
                <input id="step2-esop" class="input" value="${salaryEsop}" placeholder="e.g. 4">
              </div>
            </div>
            <p class="hint" style="margin-top: 8px;">Comp is only used to compute Upgrade / Lateral labels. It is never shared.</p>
          </details>
        </div>

        <div class="onb-footer">
          <button type="button" class="btn btn-ghost" id="step2-back-btn">← Back</button>
          <button type="button" class="btn btn-primary" id="step2-next-btn">Continue to preferences →</button>
        </div>
      </div></div>
    `;

    const roleInput = root.querySelector("#step2-role");
    const titleInput = root.querySelector("#step2-title");
    const employerInput = root.querySelector("#step2-employer");
    const startInput = root.querySelector("#step2-career-start");
    const fixedInput = root.querySelector("#step2-fixed");
    const esopInput = root.querySelector("#step2-esop");
    const backBtn = root.querySelector("#step2-back-btn");
    const nextBtn = root.querySelector("#step2-next-btn");
    const newSkillInput = root.querySelector("#onb-new-skill");
    const addSkillBtn = root.querySelector("#onb-add-skill-btn");

    root.querySelectorAll("[data-remove-skill]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const item = btn.dataset.removeSkill;
        skills = skills.filter((s) => s !== item);
        renderStep2();
      });
    });

    const addSkill = () => {
      const val = newSkillInput.value.trim().toLowerCase();
      if (val && !skills.includes(val)) {
        skills.push(val);
        renderStep2();
      }
    };
    addSkillBtn.addEventListener("click", addSkill);
    newSkillInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        addSkill();
      }
    });

    backBtn.addEventListener("click", () => {
      step = 1;
      renderStep();
    });

    nextBtn.addEventListener("click", () => {
      targetRole = roleInput.value.trim() || targetRole;
      currentTitle = titleInput.value.trim() || currentTitle;
      currentEmployer = employerInput.value.trim() || currentEmployer;
      careerStartDate = startInput.value.trim() || careerStartDate;
      if (fixedInput) salaryFixed = fixedInput.value.trim();
      if (esopInput) salaryEsop = esopInput.value.trim();

      step = 3;
      renderStep();
    });
  }

  function renderStep3() {
    root.innerHTML = ui.html`
      <div class="page"><div class="onb-wrap">
        <div class="onb-header">
          <p class="onb-step-tag">Step 3 of 3</p>
          <h1>Where and when</h1>
          <p>Choose where you'd like to work and when to receive your fresh match digests.</p>
        </div>

        <div class="onb-progress" aria-hidden="true">
          <div class="onb-progress-bar is-active"></div>
          <div class="onb-progress-bar is-active"></div>
          <div class="onb-progress-bar is-active"></div>
        </div>

        <div class="card onb-card">
          <div class="field">
            <label class="label">Target locations</label>
            <div class="onb-tags-wrap" id="onb-loc-list">
              ${locations.map((loc) => ui.html`
                <span class="chip-edit">
                  ${loc}
                  <button type="button" data-remove-loc="${loc}" aria-label="Remove location ${loc}">×</button>
                </span>
              `)}
              <div class="onb-add-tag-box">
                <input id="onb-new-loc" class="onb-add-tag-input" placeholder="+ Add city">
                <button type="button" class="btn btn-ghost" id="onb-add-loc-btn" style="min-height:36px; padding: 0 10px; font-size:13px;">Add</button>
              </div>
            </div>
          </div>

          <div class="row" style="padding: 10px 0; border-top: 1px solid var(--border);">
            <div>
              <p style="font-weight:600; font-size:14px;">Include remote roles</p>
              <p class="hint">Search remote and hybrid opportunities in addition to preferred cities.</p>
            </div>
            <label class="switch">
              <input type="checkbox" id="onb-remote-toggle" ${remoteActive ? "checked" : ""}>
              <span class="track" aria-hidden="true"></span>
            </label>
          </div>

          <div class="row" style="padding: 10px 0; border-top: 1px solid var(--border);">
            <div>
              <p style="font-weight:600; font-size:14px;">Send email digests</p>
              <p class="hint">Twice-daily summaries of newly scored opportunities.</p>
            </div>
            <label class="switch">
              <input type="checkbox" id="onb-digest-toggle" ${digestEnabled ? "checked" : ""}>
              <span class="track" aria-hidden="true"></span>
            </label>
          </div>

          <div class="onb-grid-2" style="border-top: 1px solid var(--border); padding-top: 14px;">
            <div class="field">
              <label for="step3-hour">Morning digest time</label>
              <select id="step3-hour" class="select">
                <option value="8">8:00 AM</option>
                <option value="9" selected>9:00 AM</option>
                <option value="10">10:00 AM</option>
                <option value="11">11:00 AM</option>
              </select>
            </div>
            <div class="field">
              <label for="step3-tz">Timezone</label>
              <input id="step3-tz" class="input" value="Asia/Kolkata" readonly style="background: var(--surface-2); color: var(--text-2);">
            </div>
          </div>
        </div>

        <div class="onb-footer">
          <button type="button" class="btn btn-ghost" id="step3-back-btn">← Back</button>
          <button type="button" class="btn btn-primary" id="step3-submit-btn">Find my matches ✨</button>
        </div>
      </div></div>
    `;

    const locInput = root.querySelector("#onb-new-loc");
    const addLocBtn = root.querySelector("#onb-add-loc-btn");
    const remoteToggle = root.querySelector("#onb-remote-toggle");
    const digestToggle = root.querySelector("#onb-digest-toggle");
    const hourSelect = root.querySelector("#step3-hour");
    const backBtn = root.querySelector("#step3-back-btn");
    const submitBtn = root.querySelector("#step3-submit-btn");

    root.querySelectorAll("[data-remove-loc]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const item = btn.dataset.removeLoc;
        locations = locations.filter((l) => l !== item);
        renderStep3();
      });
    });

    const addLoc = () => {
      const val = locInput.value.trim();
      if (val && !locations.includes(val)) {
        locations.push(val);
        renderStep3();
      }
    };
    addLocBtn.addEventListener("click", addLoc);
    locInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        addLoc();
      }
    });

    remoteToggle.addEventListener("change", (e) => {
      remoteActive = e.target.checked;
    });
    digestToggle.addEventListener("change", (e) => {
      digestEnabled = e.target.checked;
    });

    backBtn.addEventListener("click", () => {
      step = 2;
      renderStep();
    });

    submitBtn.addEventListener("click", async () => {
      submitBtn.disabled = true;
      submitBtn.textContent = "Setting up your account…";
      digestHour = parseInt(hourSelect.value, 10) || 9;

      const profile = {
        targetDesignation: targetRole,
        currentEmployer,
        currentTitle,
        careerStartDate,
        currentSalaryFixedLPA: salaryFixed ? parseFloat(salaryFixed) : undefined,
        currentSalaryEsopLPA: salaryEsop ? parseFloat(salaryEsop) : undefined,
        currentSalaryCurrency: salaryCurrency,
        preferredCity: locations[0] || "Bengaluru",
        preferredCountry: "India",
        skills,
      };

      // Update store so routes immediately recognize that CV and profile exist
      store.set({
        hasCv: true,
        cvText,
        profile,
        digest: {
          enabled: digestEnabled,
          hour: digestHour,
        },
      });

      ui.toast({ message: "Welcome to JobMatcher! Finding your matches…" });
      ui.announce("Onboarding complete. Navigating to matches feed.");
      
      // Navigate to matches view
      navigate("matches");
    });
  }

  renderStep();
}
