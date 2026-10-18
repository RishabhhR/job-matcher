// Profile view (TASK-057, TASK-061, antigravity).
// Spec: design/ui-redesign/README.md section 3.2 + mockup 'Profile'.
// CV card with parsed summary + Replace CV + PII-redacted text disclosure.
// Experience & pay with helper copy.
// Saves persisted via api.saveProfile (TASK-063).

export const title = "Profile";

function redactPii(text) {
  if (!text) return "";
  return text
    .replace(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g, "[email redacted]")
    .replace(/(?:\+?\d{1,4}[-.\s]?)?(?:\(?\d{2,5}\)?[-.\s]?)?\d{3,5}[-.\s]?\d{3,5}\b/g, (match) => {
      const digits = match.replace(/\D/g, "");
      return digits.length >= 7 ? "[phone redacted]" : match;
    });
}

function normalizeMonth(val) {
  if (!val) return "";
  const trimmed = String(val).trim();
  if (/^\d{4}-\d{2}$/.test(trimmed)) return trimmed;
  if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) return trimmed.slice(0, 7);
  const d = new Date(trimmed.length === 4 && /^\d{4}$/.test(trimmed) ? `${trimmed}-01-01` : trimmed);
  if (!isNaN(d.getTime())) {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, "0");
    if (y >= 1950 && y <= 2100) return `${y}-${m}`;
  }
  return "";
}

export async function render(root, { store, api, ui }) {
  const state = store.get();
  const userId = state.userId;
  const profile = state.profile || {};
  let cvText = state.cvText || "";
  let hasCv = state.hasCv;

  let targetRole = profile.targetDesignation || "";
  let currentTitle = profile.currentTitle || "";
  let currentCompany = profile.currentEmployer || "";
  let careerStartDate = normalizeMonth(profile.careerStartDate) || "";
  let salaryFixed = profile.currentSalaryFixedLPA != null ? String(profile.currentSalaryFixedLPA) : "";
  let salaryEsop = profile.currentSalaryEsopLPA != null ? String(profile.currentSalaryEsopLPA) : "";
  let salaryCurrency = profile.currentSalaryCurrency || "INR";

  let skills = Array.isArray(profile.skills) ? [...profile.skills] : [];

  let isUploadingCv = false;
  let isSaving = false;

  function renderView() {
    root.innerHTML = ui.html`
      <div class="page"><div class="profile-stack">
        <h1 class="page-title">Profile</h1>

        <!-- Section 1: Your CV -->
        <section class="card profile-section" aria-labelledby="profile-cv-heading">
          <h2 id="profile-cv-heading">Your CV</h2>
          <p class="muted">We read your CV to score jobs. Only the summary below is shown here; your contact details stay private.</p>
          
          <div class="profile-cv-card">
            <div class="profile-file-badge" aria-hidden="true">PDF</div>
            <div class="profile-cv-info">
              <p class="profile-cv-filename">${hasCv ? "Uploaded_CV.pdf" : "No CV uploaded yet"}</p>
              <p class="profile-cv-summary">
                ${hasCv
                  ? `${(currentTitle && currentCompany) ? `${currentTitle} at ${currentCompany}` : (currentTitle || currentCompany || "CV uploaded")}${careerStartDate ? ` · Career start: ${careerStartDate}` : " · Verified profile"}`
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
              <p class="hint" style="margin-top: 6px;">Contact details (phone numbers and emails) are automatically redacted.</p>
              <div class="profile-raw-text">${redactPii(cvText)}</div>
            </details>
          ` : ""}
        </section>

        <!-- Section 2: Target Role & Skills -->
        <section class="card profile-section" aria-labelledby="profile-role-heading">
          <h2 id="profile-role-heading">What you're looking for</h2>
          <p class="muted">Target role decides which jobs we search. Skills from your CV decide how we score them.</p>

          <div class="field">
            <label for="profile-role">Target role</label>
            <input id="profile-role" class="input" value="${targetRole}" placeholder="e.g. Product Manager">
          </div>

          <div class="profile-tag-group">
            <p class="profile-tag-title">Skills & tags <span class="muted" style="font-weight:400;">(from your CV)</span></p>
            <div class="profile-tag-row">
              ${skills.length > 0 ? skills.map((tag) => ui.html`
                <span class="chip profile-chip-cv">${tag}</span>
              `) : ui.html`<p class="muted" style="font-size:13px; margin: 4px 0;">No skills extracted or saved yet.</p>`}
            </div>
          </div>
        </section>

        <!-- Section 3: Experience & Pay -->
        <section class="card profile-section" aria-labelledby="profile-exp-heading">
          <h2 id="profile-exp-heading">Experience and pay</h2>
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
              <input id="profile-start-date" type="month" class="input" value="${careerStartDate}" placeholder="YYYY-MM">
              <p class="hint">Used to estimate your years of experience for seniority caps (YYYY-MM).</p>
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
            <button type="button" class="btn btn-primary" id="profile-save-btn" ${isSaving ? "disabled" : ""}>
              ${isSaving ? "Saving…" : "Save changes"}
            </button>
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
            const uploadRes = await api.uploadCv(e.target.files[0]);
            const newCvText = uploadRes.text || "";
            if (userId) {
              const saveRes = await api.saveProfile(userId, { cvText: newCvText });
              cvText = newCvText;
              hasCv = Boolean(saveRes.hasCv ?? (newCvText && newCvText.trim()));
              store.set({ cvText: newCvText, hasCv, profile: saveRes.profile || profile });
            } else {
              cvText = newCvText;
              hasCv = true;
              store.set({ cvText, hasCv: true });
            }
            ui.toast({ message: "CV uploaded and saved successfully!" });
            ui.announce("CV uploaded and saved.");
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

    // Wire Save Changes
    const saveBtn = root.querySelector("#profile-save-btn");
    if (saveBtn) {
      saveBtn.addEventListener("click", async () => {
        const roleVal = root.querySelector("#profile-role")?.value.trim() || "";
        const titleVal = root.querySelector("#profile-title")?.value.trim() || "";
        const employerVal = root.querySelector("#profile-employer")?.value.trim() || "";
        const rawDate = root.querySelector("#profile-start-date")?.value.trim();
        const startVal = normalizeMonth(rawDate) || (rawDate === "" ? null : undefined);
        const fixedVal = root.querySelector("#profile-fixed")?.value.trim() || "";
        const esopVal = root.querySelector("#profile-esop")?.value.trim() || "";

        const updatedProfile = {
          ...profile,
          targetDesignation: roleVal,
          currentTitle: titleVal || undefined,
          currentEmployer: employerVal || undefined,
          careerStartDate: startVal,
          currentSalaryFixedLPA: fixedVal ? parseFloat(fixedVal) : undefined,
          currentSalaryEsopLPA: esopVal ? parseFloat(esopVal) : undefined,
          currentSalaryCurrency: salaryCurrency,
          skills,
        };

        isSaving = true;
        renderView();
        try {
          if (userId) {
            const saveRes = await api.saveProfile(userId, { profile: updatedProfile });
            const saved = saveRes.profile || updatedProfile;
            targetRole = saved.targetDesignation || "";
            currentTitle = saved.currentTitle || "";
            currentCompany = saved.currentEmployer || "";
            careerStartDate = normalizeMonth(saved.careerStartDate) || "";
            store.set({ profile: saved });
          } else {
            store.set({ profile: updatedProfile });
          }
          ui.toast({ message: "Profile saved successfully!" });
          ui.announce("Profile changes saved.");
        } catch (err) {
          console.error(err);
          ui.toast({ message: err.message || "Failed to save profile" });
        } finally {
          isSaving = false;
          renderView();
        }
      });
    }
  }

  renderView();
}
