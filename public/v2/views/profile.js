// Profile view (TASK-057, antigravity).
// Spec: design/ui-redesign/README.md section 3.2 + mockup 'Profile'.
// CV card with parsed summary + Replace CV + View text disclosure.
// Editable 'Looking for' vs 'From your CV' tags.
// Experience & pay with helper copy.

export const title = "Profile";

export async function render(root, { store, api, ui }) {
  const state = store.get();
  const profile = state.profile || {};
  let cvText = state.cvText || "";
  let hasCv = state.hasCv;

  let targetRole = profile.targetDesignation || "Product Manager";
  let currentTitle = profile.currentTitle || "Associate Product Manager";
  let currentCompany = profile.currentEmployer || "Zepto";
  let careerStartDate = profile.careerStartDate || "Jul 2024";
  let salaryFixed = profile.currentSalaryFixedLPA != null ? String(profile.currentSalaryFixedLPA) : "";
  let salaryEsop = profile.currentSalaryEsopLPA != null ? String(profile.currentSalaryEsopLPA) : "";
  let salaryCurrency = profile.currentSalaryCurrency || "INR";

  // Tags
  let lookingFor = (profile.lookingFor && profile.lookingFor.length)
    ? [...profile.lookingFor]
    : ["product management", "growth", "consumer", "fintech"];
    
  let fromCv = (profile.skills && profile.skills.length)
    ? [...profile.skills]
    : ["quick commerce", "pricing", "experimentation", "SQL", "growth loops"];

  let isUploadingCv = false;

  function renderView() {
    root.innerHTML = ui.html`
      <div class="page"><div class="profile-stack">
        <!-- Section 1: Your CV -->
        <section class="card profile-section">
          <h2>Your CV</h2>
          <p class="muted">We read your CV to score jobs. Only the summary below is shown here; your contact details stay private.</p>
          
          <div class="profile-cv-card">
            <div class="profile-file-badge" aria-hidden="true">PDF</div>
            <div class="profile-cv-info">
              <p class="profile-cv-filename">${hasCv ? "Uploaded_CV.pdf" : "No CV uploaded yet"}</p>
              <p class="profile-cv-summary">
                ${hasCv
                  ? `${currentTitle} at ${currentCompany} · ${careerStartDate ? `Career start: ${careerStartDate}` : "Verified profile"}`
                  : "Upload your CV to unlock personalized matching and scoring."}
              </p>
            </div>
            <div>
              <input type="file" id="profile-replace-file" accept=".pdf,.docx,.txt" hidden>
              <button type="button" class="btn btn-ghost" id="profile-replace-btn" ${isUploadingCv ? "disabled" : ""}>
                ${isUploadingCv ? "Uploading…" : (hasCv ? "Replace CV" : "Upload CV")}
              </button>
            </div>
          </div>

          ${hasCv && cvText ? ui.html`
            <details class="profile-disclosure">
              <summary>View extracted text</summary>
              <div class="profile-raw-text">${cvText}</div>
            </details>
          ` : ""}
        </section>

        <!-- Section 2: Target Role & Tags -->
        <section class="card profile-section">
          <h2>What you're looking for</h2>
          <p class="muted">"Looking for" tags decide which jobs we search. "From your CV" tags decide how we score them.</p>

          <div class="field">
            <label for="profile-role">Target role</label>
            <input id="profile-role" class="input" value="${targetRole}" placeholder="e.g. Product Manager">
          </div>

          <div class="profile-tag-group">
            <p class="profile-tag-title">Looking for</p>
            <div class="profile-tag-row" id="profile-looking-for-row">
              ${lookingFor.map((tag) => ui.html`
                <span class="chip-edit">
                  ${tag}
                  <button type="button" data-remove-looking="${tag}" aria-label="Remove tag ${tag}">×</button>
                </span>
              `)}
              <div class="profile-add-chip">
                <input id="profile-new-looking" class="profile-add-input" placeholder="+ Add tag">
                <button type="button" class="btn btn-ghost" id="profile-add-looking-btn" style="min-height:36px; padding:0 10px; font-size:13px;">Add</button>
              </div>
            </div>
          </div>

          <div class="profile-tag-group">
            <p class="profile-tag-title">From your CV</p>
            <div class="profile-tag-row">
              ${fromCv.map((tag) => ui.html`
                <span class="chip profile-chip-cv">${tag}</span>
              `)}
            </div>
          </div>
        </section>

        <!-- Section 3: Experience & Pay -->
        <section class="card profile-section">
          <h2>Experience and pay</h2>
          <p class="muted">Pay is only used to label jobs as Upgrade, Lateral or Downgrade. It's never shared.</p>

          <div class="profile-kv-grid">
            <div class="field">
              <label for="profile-title">Current title</label>
              <input id="profile-title" class="input" value="${currentTitle}" placeholder="e.g. Associate Product Manager">
            </div>
            <div class="field">
              <label for="profile-employer">Current company</label>
              <input id="profile-employer" class="input" value="${currentCompany}" placeholder="e.g. Zepto">
            </div>
            <div class="field">
              <label for="profile-start-date">Career start date</label>
              <input id="profile-start-date" class="input" value="${careerStartDate}" placeholder="e.g. Jul 2024">
              <p class="hint">Used to estimate your years of experience for seniority caps.</p>
            </div>
            <div class="field">
              <label for="profile-fixed">Total fixed pay (LPA, fixed + ESOP)</label>
              <div style="display:flex; gap:8px;">
                <input id="profile-fixed" class="input" value="${salaryFixed}" placeholder="Fixed (e.g. 18)">
                <input id="profile-esop" class="input" value="${salaryEsop}" placeholder="ESOP (e.g. 4)">
              </div>
            </div>
          </div>

          <div class="profile-save-bar">
            <button type="button" class="btn btn-primary" id="profile-save-btn">Save changes</button>
          </div>
        </section>
      </div></div>
    `;

    // Wire Replace CV
    const replaceBtn = root.querySelector("#profile-replace-btn");
    const replaceFile = root.querySelector("#profile-replace-file");
    if (replaceBtn && replaceFile) {
      replaceBtn.addEventListener("click", () => replaceFile.click());
      replaceFile.addEventListener("change", async (e) => {
        if (e.target.files && e.target.files[0]) {
          isUploadingCv = true;
          renderView();
          try {
            const res = await api.uploadCv(e.target.files[0]);
            cvText = res.text || "";
            hasCv = true;
            store.set({ cvText, hasCv: true });
            ui.toast({ message: "CV updated successfully!" });
          } catch (err) {
            console.error(err);
            ui.toast({ message: err.message || "Failed to upload CV" });
          } finally {
            isUploadingCv = false;
            renderView();
          }
        }
      });
    }

    // Wire Looking For tag removals
    root.querySelectorAll("[data-remove-looking]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const item = btn.dataset.removeLooking;
        lookingFor = lookingFor.filter((t) => t !== item);
        renderView();
      });
    });

    // Wire Add Looking For tag
    const newLookingInput = root.querySelector("#profile-new-looking");
    const addLookingBtn = root.querySelector("#profile-add-looking-btn");
    const addLooking = () => {
      const val = newLookingInput.value.trim().toLowerCase();
      if (val && !lookingFor.includes(val)) {
        lookingFor.push(val);
        renderView();
      }
    };
    if (addLookingBtn && newLookingInput) {
      addLookingBtn.addEventListener("click", addLooking);
      newLookingInput.addEventListener("keydown", (e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          addLooking();
        }
      });
    }

    // Wire Save Changes
    const saveBtn = root.querySelector("#profile-save-btn");
    if (saveBtn) {
      saveBtn.addEventListener("click", async () => {
        const roleVal = root.querySelector("#profile-role")?.value.trim() || targetRole;
        const titleVal = root.querySelector("#profile-title")?.value.trim() || currentTitle;
        const employerVal = root.querySelector("#profile-employer")?.value.trim() || currentCompany;
        const startVal = root.querySelector("#profile-start-date")?.value.trim() || careerStartDate;
        const fixedVal = root.querySelector("#profile-fixed")?.value.trim() || salaryFixed;
        const esopVal = root.querySelector("#profile-esop")?.value.trim() || salaryEsop;

        const updatedProfile = {
          ...profile,
          targetDesignation: roleVal,
          currentTitle: titleVal,
          currentEmployer: employerVal,
          careerStartDate: startVal,
          currentSalaryFixedLPA: fixedVal ? parseFloat(fixedVal) : undefined,
          currentSalaryEsopLPA: esopVal ? parseFloat(esopVal) : undefined,
          currentSalaryCurrency: salaryCurrency,
          lookingFor,
          skills: fromCv,
        };

        store.set({ profile: updatedProfile });
        ui.toast({ message: "Profile changes saved!" });
        ui.announce("Profile changes saved.");
      });
    }
  }

  renderView();
}
